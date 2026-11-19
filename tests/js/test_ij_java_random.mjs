// IJShared.JavaRandom (js/modules/studio/advanced-studio/ij-proc-shared.js) against java.util.Random of a JDK 21:
// tests/fixtures/ij-wave3/javarandom.json holds, per seed, 1000 values of nextInt / nextLong / nextDouble / nextFloat /
// nextBoolean / nextGaussian, 200 values of nextInt(bound) for 14 bounds (powers of two, the rejection loop, 2^31-1),
// and 300 interleaved calls with a setSeed in the middle (the cached second Gaussian must be dropped by setSeed).
// Doubles are compared bit for bit (this also asserts V8's Math.log / Math.sqrt = StrictMath for the polar method).
// Run: node tests/js/test_ij_java_random.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const sandbox = { console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/studio/advanced-studio/ij-proc-shared.js'), 'utf8'), sandbox, { filename: 'ij-proc-shared.js' });
const { JavaRandom } = sandbox.IJShared;
assert.equal(typeof JavaRandom, 'function');

const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/ij-wave3/javarandom.json'), 'utf8'));
assert.equal(fx.seeds.length, 6);
const f32 = Math.fround;
let checked = 0;

function same(actual, expected, what) {
  assert.ok(Object.is(actual, expected), `${what}: got ${actual}, expected ${expected}`);
  checked++;
}
for (const s of fx.seeds) {
  const seed = BigInt(s.seed);
  const tag = `seed ${s.seed}`;
  let r = new JavaRandom(seed);
  s.nextInt.forEach((v, i) => same(r.nextInt(), v, `${tag} nextInt[${i}]`));
  r = new JavaRandom(seed);
  s.nextLong.forEach((v, i) => { const g = r.nextLong(); assert.equal(typeof g, 'bigint'); assert.equal(g, BigInt(v), `${tag} nextLong[${i}]`); checked++; });
  r = new JavaRandom(seed);
  s.nextDouble.forEach((v, i) => same(r.nextDouble(), v, `${tag} nextDouble[${i}]`));
  r = new JavaRandom(seed);
  s.nextFloat.forEach((v, i) => same(r.nextFloat(), f32(v), `${tag} nextFloat[${i}]`));
  r = new JavaRandom(seed);
  s.nextBoolean.forEach((v, i) => same(r.nextBoolean(), v, `${tag} nextBoolean[${i}]`));
  r = new JavaRandom(seed);
  s.nextGaussian.forEach((v, i) => same(r.nextGaussian(), v, `${tag} nextGaussian[${i}]`));
  for (const b of s.bounded) {
    r = new JavaRandom(seed);
    b.values.forEach((v, i) => same(r.nextInt(b.bound), v, `${tag} nextInt(${b.bound})[${i}]`));
  }
  r = new JavaRandom(seed);
  s.mixKinds.forEach((k, i) => {
    const e = s.mixValues[i], w = `${tag} mix[${i}] ${k}`;
    switch (k) {
      case 'S': r.setSeed(seed + 7n); break;
      case 'G': same(r.nextGaussian(), Number(e), w); break;
      case 'I': same(r.nextInt(), Number(e), w); break;
      case 'D': same(r.nextDouble(), Number(e), w); break;
      case 'B': same(r.nextBoolean(), e === 'true', w); break;
      case 'L': assert.equal(r.nextLong(), BigInt(e), w); checked++; break;
      case 'F': same(r.nextFloat(), f32(Number(e)), w); break;
      default: same(r.nextInt(7), Number(e), w);
    }
  });
}

// seeds given as Numbers equal the BigInt form (negative and large safe integers included)
for (const s of fx.seeds) {
  const n = Number(s.seed);
  if (!Number.isSafeInteger(n)) continue;
  const a = new JavaRandom(n), b = new JavaRandom(BigInt(s.seed));
  for (let i = 0; i < 50; i++) assert.equal(a.nextInt(), b.nextInt());
}
// setSeed restarts the stream and clears the cached Gaussian
{
  const a = new JavaRandom(42n), g1 = a.nextGaussian();
  a.setSeed(42n);
  assert.ok(Object.is(a.nextGaussian(), g1));
  a.setSeed(42n); a.nextGaussian(); a.setSeed(42n);
  assert.ok(Object.is(a.nextGaussian(), g1), 'the second Gaussian of the old stream is dropped');
}
// refusals
const r0 = new JavaRandom(1);
for (const b of [0, -3, 2147483648, 1.5, NaN]) assert.throws(() => r0.nextInt(b), (e) => e.name === 'RangeError');
assert.throws(() => new JavaRandom(NaN), (e) => e.code === 'IJ_BAD_SEED');
assert.throws(() => new JavaRandom(1e20), (e) => e.code === 'IJ_BAD_SEED');
assert.throws(() => new JavaRandom(Infinity), (e) => e.code === 'IJ_BAD_SEED');
// no seed: usable, and two unseeded generators differ
assert.notEqual(new JavaRandom().nextLong(), new JavaRandom().nextLong());
// known value: new Random(42).nextInt() = -1170105035 (the JDK documentation example everyone knows)
assert.equal(new JavaRandom(42).nextInt(), -1170105035);

console.log(`test_ij_java_random: ${checked} java.util.Random values reproduced exactly`);
