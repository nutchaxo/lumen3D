// Studio figures of a STABILISED timelapse show what the screen shows.
//
// A 'live' dataset whose registration applies to the volume is drawn through the
// VOLUME_WARP variant of the ray-march shader: uvw = volumeWarp·p (object space →
// texture of the timepoint on screen), the clip ranges acting in the display box
// (clipBoxMin + clipCoord ⊙ clipBoxSize, the enlarged geometry). The slicer sampled
// uvw = base + ½ whatever the material, so every Studio figure of such a dataset (slice
// tool, z-stack browser, native LOD0 upgrade, Compare Studio) was in the raw acquisition
// frame — turned and shifted by the timepoint's rigid transform, the z-stack slab not
// the one on screen. Checked here, against the real volume-viewer.js code
// (setStabilizationSpace / setTimepointTransform / getClipSpace lifted from the source):
//   1. the slice shader reads the texture through the warp in every sampling path (one
//      plane, slab; RAW_OUTPUT and colour), and every #ifdef combination of
//      ENABLE_SVR / FALLBACK_TEX / RAW_OUTPUT / VOLUME_WARP declares what it uses;
//   2. a point of the Studio plane reaches the texture coordinate the ray-marcher gives
//      the same object point (object → display µm → raw µm → texture, independently);
//   3. planeGeometry with a sampling space: the plane stays put in cube space, the frame
//      is centred on the display box and holds the cut of any plane through it, the
//      texture-space centre / normal / slab half-thickness are the warped plane's, and
//      the pixel size / render size follow the frame;
//   4. the z-stack spec samples exactly the display-box slab the clip range shows;
//   5. the native pass picks every brick the warped plane samples (brute force), and
//      nothing farther than one voxel of slack from it;
//   6. plumbing: the define follows the source material (toggle included), the warp is
//      linked by reference, the cached foreign programs are keyed by the warp, and the
//      native pass's throwaway material carries a frozen copy of it;
//   7. unwarped: the former geometry and spec, number for number.
//
// Run: node tests/js/test_slicer_warp.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// ── A realm with three.js, the slicer and a fake renderer ─────────────────────
function makeCanvas() {
  const ctx2d = {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, clearRect() {}, fillRect() {}, fillText() {}, drawImage() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  return { width: 0, height: 0, className: '', style: {}, getContext: () => ctx2d };
}
const ctx = vm.createContext({
  console, setTimeout, clearTimeout,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  document: { createElement: () => makeCanvas() },
  window: {},
});
vm.runInContext(readFileSync(path.join(ROOT, 'js/vendor/three.min.js'), 'utf8'), ctx, { filename: 'three.min.js' });
const SLICER = read('js/viewers/volume-slicer.js');
vm.runInContext(SLICER + '\n;globalThis.VolumeSlicer = VolumeSlicer;', ctx, { filename: 'volume-slicer.js' });
const { THREE, VolumeSlicer } = ctx;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
// What the page's VolumeViewer gives the slicer (its frame is measured in P units).
ctx.VolumeViewer = { getPhysicalSize: () => PHYSICAL };

const VOLUME = read('js/viewers/volume-viewer.js');
const VIEWER = read('js/pages/viewer.js');
function lift(src, name, file) {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name} must be defined at module level in ${file}`);
  return m[0];
}
const clipSpaceSrc = VOLUME.match(/\n    getClipSpace: (\(\) => \{[\s\S]*?\n    \}),\n/);
assert.ok(clipSpaceSrc, 'VolumeViewer exposes getClipSpace()');

// ── The dataset: the acquisition box and display box of a real stabilised timelapse
// (Egfl7eGFP-E775 … 30 cycles: 922 × 1024 × 58 voxels, 1.38 × 1.38 × 5.76 µm), and a
// rigid transform of the size its late timepoints carry (≈ 36° about an oblique axis,
// ~250 µm of drift). ───────────────────────────────────────────────────────────
const ACQ = { min: [0, 0, 0], max: [1275.84, 1416.99, 333.868] };
const PHYSICAL = { x: 1275.84, y: 1416.99, z: 333.868 };
const DIMS0 = { x: 922, y: 1024, z: 58 };
function rigid(axis, deg, t) {
  return new THREE.Matrix4().makeRotationAxis(V(...axis).normalize(), (deg * Math.PI) / 180).setPosition(...t);
}
const M_LATE = rigid([0.25, 0.9, 0.3], 34, [212.4, -162.5, 122.8]);
const M_MID = rigid([-0.4, 1, 0.1], 17, [158.8, -142.4, 84.3]);
// The display box = the union of the frames' boxes carried into the stabilised frame
// (here: identity, the two transforms), exactly as the pipeline's imageBoxUnionUm.
function unionBox(mats) {
  const lo = V(Infinity, Infinity, Infinity), hi = V(-Infinity, -Infinity, -Infinity);
  for (const m of mats) {
    for (let i = 0; i < 8; i++) {
      const c = V(i & 1 ? ACQ.max[0] : ACQ.min[0], i & 2 ? ACQ.max[1] : ACQ.min[1], i & 4 ? ACQ.max[2] : ACQ.min[2]).applyMatrix4(m);
      lo.min(c); hi.max(c);
    }
  }
  return { min: lo.toArray(), max: hi.toArray() };
}
const UNION = unionBox([new THREE.Matrix4(), M_LATE, M_MID]);

// The ray-march material and the stabilisation code of volume-viewer.js, lifted.
function makeViewer() {
  return vm.runInContext(`(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader: 'void main() {}', fragmentShader: 'void main() {}',
      defines: { ENABLE_SVR: 1, ENABLE_CHANNEL_0: 1 },
      uniforms: {
        svrAtlas0: { value: { fakeAtlas: true } }, numChannels: { value: 1 },
        volumeWarp: { value: new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5) },
        clipBoxMin: { value: new THREE.Vector3(-0.5, -0.5, -0.5) },
        clipBoxSize: { value: new THREE.Vector3(1, 1, 1) },
        clipMin: { value: new THREE.Vector3(0, 0, 0) },
        clipMax: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
    const cube = { geometry: { dispose() {} }, userData: {} };
    let _acqExtent = null, _displayBox = null, _warpActive = false, _transitionMaterial = null;
    const _clearTransitionVolume = () => {};
    const _scheduleFrame = () => {};
    const _cutPlaneMesh = null; // no cut plane on screen here (section 8 runs its own)
    const _syncCutPlaneToOrbit = () => {};
    ${lift(VOLUME, '_objectFromUm', 'volume-viewer.js')}
    ${lift(VOLUME, 'setStabilizationSpace', 'volume-viewer.js')}
    ${lift(VOLUME, '_rebuildCubeGeometry', 'volume-viewer.js')}
    ${lift(VOLUME, 'setTimepointTransform', 'volume-viewer.js')}
    const getClipSpace = ${clipSpaceSrc[1]};
    return { material, cube, setStabilizationSpace, setTimepointTransform, getClipSpace, getMaterial: () => material,
             getPhysicalSize: () => (${JSON.stringify(PHYSICAL)}) };
  })()`, ctx, { filename: 'volume-viewer.js#stabilisation' });
}
const vv = makeViewer();
vv.setStabilizationSpace(ACQ, UNION);
assert.equal(vv.setTimepointTransform(M_LATE.toArray()), true, 'the late timepoint is warped');
const material = vv.material;
assert.equal(material.defines.VOLUME_WARP, 1);
const W = material.uniforms.volumeWarp.value.clone();
const space = VolumeSlicer.samplingSpace(material);
assert.ok(space, 'a warped material has a sampling space');
assert.deepEqual(plain(space.warp.elements), plain(W.elements), 'the slicer reads the ray-marcher matrix');
assert.deepEqual(plain(space.boxMin), plain(material.uniforms.clipBoxMin.value), 'and its display box');
assert.deepEqual(plain(space.boxSize), plain(material.uniforms.clipBoxSize.value));
assert.ok(space.boxSize.z > 2, `the display box is much deeper than the acquisition box (${space.boxSize.z.toFixed(2)})`);

// Object point → texture, independently of the matrix volume-viewer.js composes:
// display µm = A + (o + ½) ⊙ S, raw µm = M⁻¹·display, texture = (raw − A) / S.
function textureOf(o, M = M_LATE) {
  const A = V(...ACQ.min), S = V(...ACQ.max).sub(A);
  const um = V(o.x + 0.5, o.y + 0.5, o.z + 0.5).multiply(S).add(A);
  const raw = um.applyMatrix4(M.clone().invert());
  return raw.sub(A).divide(S);
}
// The slicer's texCoord (FRAG), transcribed: cube point → volumeWarp·p.
const texCoord = (p, m = W) => p.clone().applyMatrix4(m);

// ── 1. The shader ──────────────────────────────────────────────────────────────
const FRAG = SLICER.slice(SLICER.indexOf('const FRAG = `') + 14, SLICER.indexOf('`;', SLICER.indexOf('const FRAG = `')));
function preprocess(src, defs) {
  const out = [];
  const stack = [];
  let active = true;
  for (const full of src.split('\n')) {
    const line = full.replace(/\/\/.*$/, ''); // comments carry no code
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+(\w+)/))) { stack.push({ parent: active, cond: defs.has(m[1]) }); active = active && defs.has(m[1]); continue; }
    if ((m = t.match(/^#ifndef\s+(\w+)/))) { stack.push({ parent: active, cond: !defs.has(m[1]) }); active = active && !defs.has(m[1]); continue; }
    if (/^#else\b/.test(t)) { const top = stack[stack.length - 1]; assert.ok(top, '#else without #if'); active = top.parent && !top.cond; continue; }
    if (/^#endif\b/.test(t)) { const top = stack.pop(); assert.ok(top, '#endif without #if'); active = top.parent; continue; }
    assert.ok(!/^#(if|elif)\b/.test(t), `only #ifdef / #else / #endif are expected in the slice shader: ${t}`);
    if (active) out.push(line);
  }
  assert.equal(stack.length, 0, 'balanced #ifdef / #endif');
  return out.join('\n');
}
{
  // The ray-marcher's own per-sample map, for the record: the same two expressions.
  assert.ok(/#ifdef VOLUME_WARP\s*vec3 uvw = \(volumeWarp \* vec4\(p, 1\.0\)\)\.xyz;/.test(VOLUME), 'ray-march: uvw = volumeWarp·p when warped');
  assert.ok(/#else\s*vec3 uvw = p \+ vec3\(0\.5\);/.test(VOLUME), 'ray-march: uvw = p + ½ otherwise');

  const NAMES = ['ENABLE_SVR', 'FALLBACK_TEX', 'RAW_OUTPUT', 'VOLUME_WARP'];
  const checked = new Set();
  for (let mask = 0; mask < 16; mask++) {
    const defs = new Set(NAMES.filter((_, i) => mask & (1 << i)));
    const src = preprocess(FRAG, defs);
    const label = `[${[...defs].join(', ') || 'no define'}]`;
    // Every identifier used is declared, before its first use.
    const ids = ['volumeWarp', 'texCoord', 'fallbackTex', 'fallbackRect', 'fallbackChannels', 'pageTable', 'atlasDim',
      'volumeDim', 'ptDim', 'brickSize', 'getAtlasLookup', 'sampleSVRAtlas', 'fallbackRaw', 'fallbackColor', 'projectSlab',
      'rawAt', 'colorAt', 'inBox', 'composeRaw'];
    for (const id of ids) {
      const decl = src.match(new RegExp(`(uniform\\s+\\w+\\s+${id}\\s*;|\\b(?:vec[234]|bool|float|int|void)\\s+${id}\\s*\\()`));
      const uses = [...src.matchAll(new RegExp(`\\b${id}\\b`, 'g'))].map((m) => m.index);
      if (!uses.length) continue;
      assert.ok(decl, `${label}: ${id} is used but not declared`);
      assert.equal(uses[0], decl.index + decl[0].indexOf(id), `${label}: ${id} is declared before its first use`);
    }
    // The texture is only ever read at a texCoord() of a cube point.
    const body = src.slice(src.indexOf('vec3 texCoord(vec3 p) {'));
    const tc = body.slice(0, body.indexOf('\n    }') + 6);
    if (defs.has('VOLUME_WARP')) {
      assert.ok(/uniform mat4 volumeWarp;/.test(src), `${label}: the warp uniform`);
      assert.ok(/return \(volumeWarp \* vec4\(p, 1\.0\)\)\.xyz;/.test(tc) && !/p \+ 0\.5/.test(tc), `${label}: texCoord = volumeWarp·p`);
    } else {
      assert.ok(!/volumeWarp/.test(src), `${label}: no warp anywhere`);
      assert.ok(/return p \+ 0\.5;/.test(tc), `${label}: texCoord = p + ½ (the former map)`);
    }
    assert.ok(!/base \+ 0\.5|\+ 0\.5;\s*\n\s*if \(!inBox/.test(src), `${label}: no sampling path bypasses texCoord`);
    const uvwAssign = [...src.matchAll(/vec3 uvw = ([^;]+);/g)].map((m) => m[1]);
    assert.ok(uvwAssign.length >= 2, `${label}: a single-plane path and the slab path`);
    for (const a of uvwAssign) assert.ok(/^texCoord\(/.test(a), `${label}: uvw = ${a}`);
    const main = src.slice(src.indexOf('void main() {'));
    assert.ok(/vec3 uvw = texCoord\(base\);\s*if \(!inBox\(uvw\)\)/.test(main), `${label}: one plane: texCoord(base), in-box test on the texture coordinate`);
    assert.ok(/projectSlab\(base, hits, missing\)/.test(main), `${label}: slab from the cube point`);
    assert.ok(/vec3 uvw = texCoord\(base \+ \(-halfSlab \+ float\(i\) \* slabDelta\) \* sliceNormal\);\s*if \(!inBox\(uvw\)\) continue;/.test(src),
      `${label}: every slab sample is warped, then tested in texture space`);
    for (const call of main.matchAll(/\b(rawAt|colorAt)\(([^,)]+)/g)) assert.equal(call[2], 'uvw', `${label}: ${call[1]} reads a texCoord`);
    checked.add(label);
  }
  assert.equal(checked.size, 16, 'every define combination');
  console.log('slice shader: the warp in every sampling path, 16 define combinations consistent: OK');
}

// ── 2. The Studio plane reads the voxel the ray-marcher reads ─────────────────
{
  // The matrix setTimepointTransform composes IS object → display µm → raw µm → texture.
  for (const o of [V(0, 0, 0), V(-0.5, 0.5, -0.5), V(0.3, -0.2, 0.41), V(-0.59, 0.51, -2.4)]) {
    const a = texCoord(o), b = textureOf(o);
    near(a.distanceTo(b), 0, 1e-12, `volumeWarp·${o.toArray()} = the independent chain`);
  }
  const specs = [
    { mode: 'xy', value: 0.37 },
    { mode: 'xz', value: 0.62 },
    { mode: 'oblique', value: 0.44, yaw: 25, pitch: 35, roll: 10 },
    { mode: 'oblique', value: 0.5, yaw: 180, pitch: 0, roll: 63, slabThickness: 7, slabStepNorm: 1 / 58, projection: 'mip' },
  ];
  for (const spec of specs) {
    const g0 = VolumeSlicer.planeGeometry(spec, PHYSICAL);
    const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, space);
    assert.equal(g.warped, true);
    // The plane lives in cube space (the display frame, where the cut plane and the
    // clip ranges live): same in-plane axes; its value sweeps the display box
    // (planeSweep), so it sits at planeDepth along its normal — the frame centre too.
    const n0 = V(0, 0, 0).crossVectors(g0.right, g0.up).normalize();
    near(g.right.distanceTo(g0.right), 0, 0, `${spec.mode}: canvas right unchanged`);
    near(g.up.distanceTo(g0.up), 0, 0, `${spec.mode}: canvas up unchanged`);
    const pNormal = VolumeSlicer.planeGeometry({ ...spec, projection: 'single', slabThickness: 1 }, null).step; // the P normal (scale 1)
    const onPlane = pNormal.clone().multiplyScalar(VolumeSlicer.planeDepth(spec, PHYSICAL, space));
    near(g.origin.clone().sub(onPlane).dot(n0), 0, 1e-12, `${spec.mode}: the recentred frame lies on the plane planeDepth places`);
    // A pixel of the Studio plane: cube point base (the FRAG's), texture = W·base.
    const tNormal = g.normal;
    for (const [a, b] of [[0, 0], [0.7, -0.2], [-0.5, 0.66], [g.extent * 0.99, -g.extent * 0.99]]) {
      const base = g.origin.clone().addScaledVector(g.right, a).addScaledVector(g.up, b);
      const uvw = texCoord(base);
      near(uvw.distanceTo(textureOf(base)), 0, 1e-12, `${spec.mode} (${a}, ${b}): the slicer's texel = the ray-marcher's for that object point`);
      near(uvw.clone().sub(g.center).dot(tNormal), 0, 1e-12, `${spec.mode}: W·(plane) is planeGeometry's texture plane`);
    }
    // The texture-space normal is W's image of the plane: perpendicular to W·right, W·up.
    const L = new THREE.Matrix3().setFromMatrix4(W);
    near(g.right.clone().applyMatrix3(L).dot(tNormal), 0, 1e-12, `${spec.mode}: normal ⟂ L·right`);
    near(g.up.clone().applyMatrix3(L).dot(tNormal), 0, 1e-12, `${spec.mode}: normal ⟂ L·up`);
    near(tNormal.length(), 1, 1e-12, `${spec.mode}: unit normal`);
    // The slab's outermost sample sits halfThickness from that plane, in texture space.
    if (g.projected) {
      const h = (g.steps - 1) * g.delta * 0.5;
      const far = texCoord(g.origin.clone().addScaledVector(g.step, h));
      near(Math.abs(far.clone().sub(g.center).dot(tNormal)), g.halfThickness, 1e-12, `${spec.mode}: slab half-thickness`);
    }
    // Before: the texture coordinate was base + ½ — a different voxel entirely.
    const before = g0.origin.clone().addScalar(0.5);
    assert.ok(before.distanceTo(texCoord(g0.origin)) > 0.05, `${spec.mode}: the raw frame was far from the screen's (${before.distanceTo(texCoord(g0.origin)).toFixed(3)})`);
  }
  console.log('Studio plane point → texture = ray-march object point → texture: OK');
}

// ── 3. The frame: centred on the display box, holding any cut through it ──────
const page = vm.runInContext(`(VolumeViewer, VolumeSlicer, env) => {
  let _zstackCurrentSlice = 0;
  const _zstackGetDims = () => ({ z: env.z() });
  const _zstackModule = () => ({ impl: { getStudioSliceRange: () => env.range() } });
  ${lift(VIEWER, '_zstackStudioSpec', 'viewer.js')}
  ${lift(VIEWER, '_zstackFlatPose', 'viewer.js')}
  ${lift(VIEWER, '_slicePixelSizeUm', 'viewer.js')}
  ${lift(VIEWER, '_nativeStudioRenderSize', 'viewer.js')}
  return { spec: _zstackStudioSpec, pixel: _slicePixelSizeUm, renderSize: _nativeStudioRenderSize };
}`, ctx, { filename: 'viewer.js#studio' });
let zDepth = 58;
let sliceRange = { lo: 20, hi: 20 };
let screen = { right: V(1, 0, 0), up: V(0, 1, 0) };
const viewerStub = {
  getScreenFrameInVolume: () => screen,
  getClipSpace: () => vv.getClipSpace(),
  getPhysicalSize: () => PHYSICAL,
  getMaterial: () => material,
};
const studio = page(viewerStub, VolumeSlicer, { z: () => zDepth, range: () => sliceRange });
{
  const maxP = Math.max(PHYSICAL.x, PHYSICAL.y, PHYSICAL.z);
  const bs = space.boxSize;
  const E = VolumeSlicer.frameExtent(space, PHYSICAL);
  near(E, Math.max(0.75, 0.5 * Math.hypot(bs.x * PHYSICAL.x / maxP, bs.y * PHYSICAL.y / maxP, bs.z * PHYSICAL.z / maxP)), 1e-15, 'E = max(EXTENT, half-diagonal of the display box in P)');
  assert.ok(E > 0.75, `this display box needs a larger frame (${E.toFixed(3)})`);
  near(VolumeSlicer.getPlaneExtentUnits(material), 2 * E, 0, 'getPlaneExtentUnits(material) = 2E');
  near(VolumeSlicer.getPlaneExtentUnits(null), 1.5, 0, 'no material: 1.5');

  // Random planes: every point of the plane inside the display box lies in the frame.
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const inBox = (p) => ['x', 'y', 'z'].every((k) => p[k] >= space.boxMin[k] && p[k] <= space.boxMin[k] + bs[k]);
  let outsideBefore = 0;
  let outsideFlat = 0;
  for (let i = 0; i < 24; i++) {
    const spec = i < 4
      ? { mode: 'oblique', value: 0.2 + 0.2 * i, yaw: 0, pitch: 0, roll: 45 } // z-stack-like, turned 45°
      : { mode: 'oblique', value: rand(), yaw: rand() * 360, pitch: rand() * 178 - 89, roll: rand() * 360 };
    const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, space);
    const g0 = VolumeSlicer.planeGeometry(spec, PHYSICAL);
    for (let a = -3; a <= 3; a += 0.01) {
      for (let b = -3; b <= 3; b += 0.01) {
        const p = g.origin.clone().addScaledVector(g.right, a).addScaledVector(g.up, b);
        if (!inBox(p)) continue;
        assert.ok(Math.abs(a) <= g.extent + 1e-9 && Math.abs(b) <= g.extent + 1e-9, `plane ${i}: (${a}, ${b}) of the display box lies outside the frame`);
        // The former frame: centred on the plane's origin, half-side 0.75.
        const q = p.clone().sub(g0.origin);
        const a0 = q.dot(g0.right) / g0.right.lengthSq();
        const b0 = q.dot(g0.up) / g0.up.lengthSq();
        if (Math.abs(a0) > 0.75 || Math.abs(b0) > 0.75) {
          outsideBefore++;
          if (i < 4) outsideFlat++;
        }
      }
    }
  }
  assert.ok(outsideFlat > 0, `the former frame cut the corners of a flat z-stack plane turned 45° off (${outsideFlat} samples)`);
  assert.ok(outsideBefore > outsideFlat, 'and more of the oblique cuts');

  // Pixel size and render size follow the frame: 2E·maxP/R, square, one pixel per voxel.
  const R = 1777;
  const px = studio.pixel({ mode: 'xy' }, R);
  near(px.x, (2 * E * maxP) / R, 1e-12, 'µm per Studio pixel');
  assert.equal(px.x, px.y, 'square');
  const g = VolumeSlicer.planeGeometry({ mode: 'oblique', yaw: 30, pitch: 20, roll: 5, value: 0.5 }, PHYSICAL, space);
  const um = (v) => Math.hypot(v.x * PHYSICAL.x, v.y * PHYSICAL.y, v.z * PHYSICAL.z) * (2 * g.extent) / R;
  near(um(g.right), px.x, 1e-9, 'one pixel along the canvas right, from the geometry');
  near(um(g.up), px.y, 1e-9, 'one pixel along the canvas up, from the geometry');
  assert.equal(studio.renderSize({ mode: 'xy' }, DIMS0), Math.ceil(1024 * 2 * E), 'render size: one pixel per voxel of the longest axis');
  console.log(`frame of a stabilised timelapse: E = ${E.toFixed(3)} (was 0.75, ${outsideBefore} display-box samples cut off), pixel = 2E·maxP/R: OK`);
}

// ── 4. The z-stack spec: the slab the clip range shows ─────────────────────────
{
  const clip = vv.getClipSpace();
  assert.equal(clip.warped, true);
  const clipCoordZ = (p) => (p.z - material.uniforms.clipBoxMin.value.z) / material.uniforms.clipBoxSize.value.z;
  const frames = [
    { right: V(1, 0, 0), up: V(0, 1, 0), back: false },
    { right: V(-1, 0, 0), up: V(0, 1, 0), back: true },
    { right: V(Math.cos(0.6), -Math.sin(0.6), 0), up: V(Math.sin(0.6), Math.cos(0.6), 0), back: false },
  ];
  const ranges = [{ lo: 0, hi: 0 }, { lo: 20, hi: 20 }, { lo: 20, hi: 24 }, { lo: 40, hi: 57 }, { lo: 0, hi: 57 }];
  let checked = 0;
  for (const f of frames) {
    screen = f;
    for (const r of ranges) {
      sliceRange = r;
      const spec = studio.spec();
      const label = `back=${f.back} slices ${r.lo}-${r.hi}`;
      assert.equal(spec.yaw, f.back ? 180 : 0, `${label}: face`);
      // The value sweeps the display box: the unwarped spec's own value, always in
      // [0, 1] — the slicer's setPlaneSpec (VolumeSlicer.recompose of a slice without
      // raw values goes through it) keeps it, and the same slab is drawn again.
      const cFrac = (r.lo + (r.hi - r.lo + 1) / 2) / zDepth;
      near(spec.value, f.back ? 1 - cFrac : cFrac, 1e-15, `${label}: value = the unwarped one`);
      assert.ok(spec.value >= 0 && spec.value <= 1, `${label}: value in [0, 1] (${spec.value})`);
      const before = VolumeSlicer.getPlaneSpec();
      VolumeSlicer.setPlaneSpec(spec);
      const kept = VolumeSlicer.getPlaneSpec();
      VolumeSlicer.setPlaneSpec(before);
      assert.equal(kept.value, spec.value, `${label}: setPlaneSpec keeps the value`);
      const gKept = VolumeSlicer.planeGeometry(kept, PHYSICAL, space);
      const gSpec = VolumeSlicer.planeGeometry(spec, PHYSICAL, space);
      near(gKept.origin.distanceTo(gSpec.origin), 0, 0, `${label}: … and the plane`);
      // What the browser does: setClipRange_z(lo / z, (hi + 1) / z).
      const zLo = r.lo / zDepth, zHi = (r.hi + 1) / zDepth;
      const z0 = clip.min.z + zLo * clip.size.z;
      const z1 = clip.min.z + zHi * clip.size.z;
      const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, space);
      near(Math.hypot(g.step.x, g.step.y), 0, 1e-12, `${label}: a plane of constant object z (the display frame)`);
      const N = Math.max(1, Math.round((z1 - z0) * zDepth));
      assert.equal(g.steps, N, `${label}: about one acquisition slice per sample`);
      assert.equal(spec.projection, N > 1 ? 'mip' : 'single', `${label}: projection`);
      const half = (g.steps - 1) * g.delta * 0.5;
      const samples = [];
      for (let k = 0; k < g.steps; k++) samples.push(g.origin.clone().addScaledVector(g.step, g.steps > 1 ? -half + k * g.delta : 0));
      samples.sort((a, b) => a.z - b.z);
      samples.forEach((s, k) => {
        near(s.z, z0 + ((k + 0.5) * (z1 - z0)) / N, 1e-12, `${label}: sample ${k} at the centre of its part of the slab`);
        const cz = clipCoordZ(s);
        assert.ok(cz >= zLo && cz <= zHi, `${label}: sample ${k} passes the shader's clip test (${cz} in [${zLo}, ${zHi}])`);
      });
      // The frame centre is the display box's (x, y): the whole slab is framed.
      near(g.origin.x, clip.min.x + clip.size.x / 2, 1e-12, `${label}: frame centred on the display box (x)`);
      near(g.origin.y, clip.min.y + clip.size.y / 2, 1e-12, `${label}: frame centred on the display box (y)`);
      // The former spec sampled texture depth (lo + ½ + k)/z of the RAW stack: not this slab.
      if (r.lo === 20 && r.hi === 20) {
        const oldCentreObj = (r.lo + 0.5) / zDepth - 0.5;
        assert.ok(oldCentreObj < z0 || oldCentreObj > z1, `${label}: the former plane (object z ${oldCentreObj.toFixed(3)}) was outside the slab on screen [${z0.toFixed(3)}, ${z1.toFixed(3)}]`);
      }
      checked++;
    }
  }
  assert.equal(checked, frames.length * ranges.length);
  console.log('z-stack Studio slab = the display-box slab of the clip range, sampled through the warp: OK');
}

// ── 5. The native pass picks every brick the warped plane samples ──────────────
function allBricks(dims) {
  const out = [];
  const bs = dims.brickSize;
  for (let bz = 0; bz < Math.ceil(dims.z / bs); bz++)
    for (let by = 0; by < Math.ceil(dims.y / bs); by++)
      for (let bx = 0; bx < Math.ceil(dims.x / bs); bx++) out.push({ bx, by, bz });
  return out;
}
const pickerSrc = lift(VIEWER, '_nativeSliceBricksForSpec', 'viewer.js');
function picker(dims, mat) {
  const c = vm.createContext({
    console, THREE, VolumeSlicer,
    BrickLoader: { activeBricks: () => allBricks(dims) },
    VolumeViewer: { getPhysicalSize: () => PHYSICAL, getMaterial: () => mat },
  });
  vm.runInContext(pickerSrc + '\n;globalThis.__fn = _nativeSliceBricksForSpec;', c, { filename: 'viewer.js#_nativeSliceBricksForSpec' });
  return (spec) => c.__fn(spec, dims);
}
const key = (b) => `${b.bx}_${b.by}_${b.bz}`;
// Voxels the native pass decodes and uploads for `picked` (a region, or the whole brick).
function decodeCost(picked, dims) {
  const bs = dims.brickSize;
  const whole = (b) => Math.min(bs, dims.x - b.bx * bs) * Math.min(bs, dims.y - b.by * bs) * Math.min(bs, dims.z - b.bz * bs);
  const decoded = picked.reduce((s, b) => s + (b.region ? (b.region.x1 - b.region.x0) * (b.region.y1 - b.region.y0) * (b.region.z1 - b.region.z0) : whole(b)), 0);
  return { decoded, wholeVoxels: picked.reduce((s, b) => s + whole(b), 0) };
}
{
  // An eighth of the dataset's x/y resolution, 16³ bricks: the same geometry, a
  // brute force that stays fast.
  const dims = { x: 115, y: 128, z: 58, brickSize: 16 };
  const pick = picker(dims, material);
  const pickOld = picker(dims, null);
  // Texture point → brick, exactly as the shader reads it (floor(uvw·dim), clamped).
  const brickAt = (u) => {
    if (u.x < 0 || u.x > 1 || u.y < 0 || u.y > 1 || u.z < 0 || u.z > 1) return null;
    const vx = Math.min(dims.x - 1, Math.floor(u.x * dims.x));
    const vy = Math.min(dims.y - 1, Math.floor(u.y * dims.y));
    const vz = Math.min(dims.z - 1, Math.floor(u.z * dims.z));
    return `${Math.floor(vx / 16)}_${Math.floor(vy / 16)}_${Math.floor(vz / 16)}`;
  };
  screen = { right: V(Math.cos(0.5), -Math.sin(0.5), 0), up: V(Math.sin(0.5), Math.cos(0.5), 0) };
  sliceRange = { lo: 22, hi: 26 };
  const cases = [
    { label: 'z-stack slab', spec: studio.spec() },
    { label: 'oblique cut', spec: { mode: 'oblique', value: 0.45, yaw: 25, pitch: 35, roll: 10, slabThickness: 1, projection: 'single' } },
    { label: 'XZ cut', spec: { mode: 'xz', value: 0.6, slabThickness: 1, projection: 'single' } },
    { label: 'oblique MIP', spec: { mode: 'oblique', value: 0.52, yaw: -40, pitch: 12, roll: 0, slabThickness: 6, projection: 'mip' } },
  ];
  const tol = (g) => g.halfThickness + Math.abs(g.normal.x) / dims.x + Math.abs(g.normal.y) / dims.y + Math.abs(g.normal.z) / dims.z;
  for (const { label, spec } of cases) {
    const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, space);
    const picked = pick(spec);
    const pickedSet = new Set(picked.map(key));
    const byKey = new Map(picked.map((b) => [key(b), b]));
    assert.ok(picked.length > 0, `${label}: bricks picked`);
    // Brute force: every sample the shader takes — the frame at a fraction of a voxel,
    // every sample of the slab — through the warp, down to the voxel it reads.
    const sampled = new Set();
    const voxels = new Set();
    const stepPc = 0.0025;
    const half = (g.steps - 1) * g.delta * 0.5;
    const offsets = g.projected ? Array.from({ length: g.steps }, (_, k) => -half + k * g.delta) : [0];
    for (let a = -g.extent; a <= g.extent; a += stepPc) {
      for (let b = -g.extent; b <= g.extent; b += stepPc) {
        const base = g.origin.clone().addScaledVector(g.right, a).addScaledVector(g.up, b);
        for (const t of offsets) {
          const u = texCoord(base.clone().addScaledVector(g.step, t));
          const k = brickAt(u);
          if (!k) continue;
          sampled.add(k);
          voxels.add(`${Math.min(dims.x - 1, Math.floor(u.x * dims.x))}_${Math.min(dims.y - 1, Math.floor(u.y * dims.y))}_${Math.min(dims.z - 1, Math.floor(u.z * dims.z))}`);
        }
      }
    }
    assert.ok(sampled.size > 10, `${label}: the plane crosses many bricks (${sampled.size})`);
    const missed = [...sampled].filter((k) => !pickedSet.has(k));
    assert.deepEqual(missed, [], `${label}: every brick the shader samples is loaded`);
    // A warped cut is tilted off every texture axis, yet each brick still hands it a
    // short run of voxels along the axis the normal leans on most: the region the
    // native pass decodes and uploads must hold every voxel the shader reads there.
    for (const v of voxels) {
      const [vx, vy, vz] = v.split('_').map(Number);
      const b = byKey.get(`${Math.floor(vx / 16)}_${Math.floor(vy / 16)}_${Math.floor(vz / 16)}`);
      const r = b.region;
      if (!r) continue;
      const lx = vx - b.bx * 16, ly = vy - b.by * 16, lz = vz - b.bz * 16;
      assert.ok(lx >= r.x0 && lx < r.x1 && ly >= r.y0 && ly < r.y1 && lz >= r.z0 && lz < r.z1,
        `${label}: voxel ${v} is read but left out of brick ${key(b)}'s region ${JSON.stringify(r)}`);
    }
    const { decoded, wholeVoxels } = decodeCost(picked, dims);
    for (const b of picked) {
      if (b.region) assert.ok(['x', 'y', 'z'].filter((k) => b.region[k + '0'] > 0 || b.region[k + '1'] < Math.min(16, dims[k] - b[`b${k}`] * 16)).length <= 1, `${label}: a region narrows one axis`);
    }
    // And nothing farther than the picker's one voxel of slack: each picked brick holds
    // a texture point within halfThickness + tolerance + one more voxel of the plane.
    const slack = tol(g) + Math.hypot(1 / dims.x, 1 / dims.y, 1 / dims.z);
    for (const b of picked) {
      const lo = V(b.bx * 16 / dims.x, b.by * 16 / dims.y, b.bz * 16 / dims.z);
      const hi = V(Math.min(dims.x, (b.bx + 1) * 16) / dims.x, Math.min(dims.y, (b.by + 1) * 16) / dims.y, Math.min(dims.z, (b.bz + 1) * 16) / dims.z);
      let dmin = Infinity;
      for (let i = 0; i < 8; i++) {
        const corner = V(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
        dmin = Math.min(dmin, corner.sub(g.center).dot(g.normal));
      }
      let dmax = -Infinity;
      for (let i = 0; i < 8; i++) {
        const corner = V(i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z);
        dmax = Math.max(dmax, corner.sub(g.center).dot(g.normal));
      }
      assert.ok(dmin <= slack && dmax >= -slack, `${label}: brick ${key(b)} is not near the warped plane`);
    }
    // The picker of v1.56.0 (texture = cube + ½) missed bricks the warped plane samples.
    const oldSet = new Set(pickOld(spec).map(key));
    const oldMissed = [...sampled].filter((k) => !oldSet.has(k));
    assert.ok(oldMissed.length > 0, `${label}: the unwarped picker missed ${oldMissed.length} of the ${sampled.size} bricks`);
    console.log(`  ${label}: ${sampled.size} bricks sampled, all among the ${picked.length} picked (the unwarped picker missed ${oldMissed.length}); ${decoded} of their ${wholeVoxels} voxels decoded`);
  }

  // A registration of a few degrees — the common case, a Kabsch fit always carries
  // some rotation — leans the texture normal off the axis, which used to cost whole
  // bricks (sixty-four planes each instead of three). The run each brick hands the
  // near-flat cut is still decoded alone, and holds every voxel the shader reads.
  // (The z axis's anisotropy multiplies a physical tilt in texture space: tens of
  // degrees make the texture plane steep, and there whole bricks are what it reads.)
  {
    const small = rigid([0.3, 1, 0.2], 3, [20, 10, 5]);
    const vs = makeViewer();
    vs.setStabilizationSpace(ACQ, unionBox([new THREE.Matrix4(), small]));
    vs.setTimepointTransform(small.toArray());
    const sSpace = VolumeSlicer.samplingSpace(vs.material);
    const clip = vs.getClipSpace();
    for (const [label, lo, hi] of [['one slice', 25, 25], ['five slices', 25, 29]]) {
      const nS = hi - lo + 1;
      const z0 = clip.min.z + (lo / 58) * clip.size.z;
      const z1 = clip.min.z + ((hi + 1) / 58) * clip.size.z;
      const steps = Math.max(1, Math.round((z1 - z0) * 58));
      const spec = { mode: 'oblique', value: (lo + nS / 2) / 58, yaw: 0, pitch: 0, roll: 20, slabThickness: steps, slabStepNorm: (z1 - z0) / steps, projection: steps > 1 ? 'mip' : 'single' };
      const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, sSpace);
      assert.ok(Math.abs(g.normal.z) < 0.999999 && Math.abs(g.normal.z) > 0.9, `${label}: a near-flat cut, off the axis (${g.normal.z.toFixed(4)})`);
      // Brute force on the small grid: the region holds every voxel the shader reads.
      const smallPicks = picker(dims, vs.material)(spec);
      const byKey = new Map(smallPicks.map((b) => [key(b), b]));
      const half = (g.steps - 1) * g.delta * 0.5;
      const offsets = g.projected ? Array.from({ length: g.steps }, (_, k) => -half + k * g.delta) : [0];
      let reads = 0;
      for (let a = -g.extent; a <= g.extent; a += 0.0025) {
        for (let b = -g.extent; b <= g.extent; b += 0.0025) {
          const base = g.origin.clone().addScaledVector(g.right, a).addScaledVector(g.up, b);
          for (const t of offsets) {
            const u = texCoord(base.clone().addScaledVector(g.step, t), sSpace.warp);
            if (u.x < 0 || u.x > 1 || u.y < 0 || u.y > 1 || u.z < 0 || u.z > 1) continue;
            const vx = Math.min(dims.x - 1, Math.floor(u.x * dims.x));
            const vy = Math.min(dims.y - 1, Math.floor(u.y * dims.y));
            const vz = Math.min(dims.z - 1, Math.floor(u.z * dims.z));
            const brick = byKey.get(`${Math.floor(vx / 16)}_${Math.floor(vy / 16)}_${Math.floor(vz / 16)}`);
            assert.ok(brick, `${label}: voxel ${vx},${vy},${vz} is read, its brick is picked`);
            const r = brick.region;
            reads++;
            if (!r) continue;
            const lz = vz - brick.bz * 16;
            assert.ok(vx - brick.bx * 16 >= r.x0 && vx - brick.bx * 16 < r.x1 && vy - brick.by * 16 >= r.y0 && vy - brick.by * 16 < r.y1 && lz >= r.z0 && lz < r.z1,
              `${label}: voxel ${vx},${vy},${vz} is read but left out of ${key(brick)}'s region ${JSON.stringify(r)}`);
          }
        }
      }
      assert.ok(reads > 1000, `${label}: the brute force read the plane (${reads})`);
      // At the dataset's own resolution (922 × 1024 × 58, 64³ bricks).
      const real = { x: 922, y: 1024, z: 58, brickSize: 64 };
      const realPicks = picker(real, vs.material)(spec);
      const cost = decodeCost(realPicks, real);
      const limit = nS === 1 ? 0.15 : 0.45;
      assert.ok(cost.decoded < limit * cost.wholeVoxels, `${label}: ${cost.decoded} of ${cost.wholeVoxels} voxels decoded (whole bricks before)`);
      assert.ok(realPicks.every((b) => !b.region || (b.region.x0 === 0 && b.region.y0 === 0
        && b.region.x1 === Math.min(64, real.x - b.bx * 64) && b.region.y1 === Math.min(64, real.y - b.by * 64))), `${label}: the run is along z, the axis the normal leans on`);
      console.log(`  3° registration, ${label}: ${realPicks.length} bricks, ${(100 * cost.decoded / cost.wholeVoxels).toFixed(1)} % of their voxels decoded`);
    }
  }

  // A drift without rotation keeps an XY cut axis-aligned in texture space: the thin
  // run of planes is still asked for, around the translated depth.
  const vt = makeViewer();
  vt.setStabilizationSpace(ACQ, UNION);
  vt.setTimepointTransform(new THREE.Matrix4().makeTranslation(40, -25, 30).toArray());
  const tSpace = VolumeSlicer.samplingSpace(vt.material);
  // The value that puts the plane at object z = −0.1 (texture 0.4 unwarped) in the
  // display box the value sweeps.
  const tClip = vt.getClipSpace();
  const spec = { mode: 'xy', value: (-0.1 - tClip.min.z) / tClip.size.z, slabThickness: 1, projection: 'single' };
  const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, tSpace);
  assert.ok(Math.abs(g.normal.z) > 0.999999, 'a translated XY plane stays axis-aligned');
  near(g.center.z, 0.4 - 30 / PHYSICAL.z, 1e-12, 'at the depth the drift moved it to');
  const regions = picker(dims, vt.material)(spec);
  assert.ok(regions.length > 0 && regions.every((b) => b.region && b.region.z1 - b.region.z0 <= 3), 'three voxel planes per brick at most');
  const vz = Math.floor(g.center.z * dims.z);
  for (const b of regions) {
    const z0 = b.bz * 16 + b.region.z0, z1 = b.bz * 16 + b.region.z1;
    assert.ok(vz >= z0 - 1 && vz <= z1, `the read voxel plane ${vz} lies in ${z0}..${z1}`);
  }
  console.log('native pass brick picker on the warped plane: OK');
}

// ── 6. Plumbing: define, linked uniform, foreign caches, the native throwaway ──
{
  const renders = [];
  const renderer = {
    autoClear: true, _target: null,
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; },
    getViewport(v) { return v.set(0, 0, 800, 600); },
    setViewport() {}, getPixelRatio: () => 1, clear() {},
    render(scene) {
      const m = scene.children[0].material;
      renders.push({
        material: m, defines: { ...m.defines }, needsUpdate: m.version,
        warpUniform: m.uniforms.volumeWarp, extent: m.uniforms.sliceExtent.value,
        origin: m.uniforms.sliceOrigin.value.clone(),
      });
    },
    readRenderTargetPixels() {},
  };
  // A fresh slicer realm (init() runs once per module instance).
  const c2 = vm.createContext({ console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, document: { createElement: () => makeCanvas() }, window: {}, THREE });
  vm.runInContext(SLICER + '\n;globalThis.VolumeSlicer = VolumeSlicer;', c2, { filename: 'volume-slicer.js#2' });
  const VS = c2.VolumeSlicer;
  c2.VolumeViewer = { getPhysicalSize: () => PHYSICAL };
  const v2 = makeViewer();
  v2.setStabilizationSpace(ACQ, UNION);
  v2.setTimepointTransform(M_LATE.toArray());
  const src = v2.material;
  assert.ok(VS.init({ renderer, material: src }), 'slicer initialises');
  VS.setPlaneSpec({ mode: 'xy', value: 0.5 });
  const E = VS.frameExtent(VS.samplingSpace(src), PHYSICAL);

  VS.renderHighRes(64);
  let r = renders.at(-1);
  assert.equal(r.defines.VOLUME_WARP, 1, 'the slicer compiles the warp for a warped source');
  assert.equal(r.warpUniform, src.uniforms.volumeWarp, 'volumeWarp linked by reference');
  near(r.extent, E, 0, 'sliceExtent = the frame of the display box');
  // The next timepoint rewrites the matrix in place: the slice follows, same program.
  v2.setTimepointTransform(M_MID.toArray());
  VS.renderHighRes(64);
  assert.equal(renders.at(-1).material, r.material, 'no rebuild for a new timepoint');
  assert.equal(renders.at(-1).warpUniform.value, src.uniforms.volumeWarp.value, 'it reads the new matrix');

  // The stabilisation toggle flips the define on the SAME source material.
  v2.setTimepointTransform(null);
  assert.equal(src.defines.VOLUME_WARP, undefined);
  VS.renderHighRes(64);
  r = renders.at(-1);
  assert.equal(r.defines.VOLUME_WARP, undefined, 'raw frame: the define follows');
  near(r.extent, 0.75, 0, 'raw frame: the former frame');
  near(r.origin.distanceTo(V(0, 0, 0)), 0, 0, 'raw frame: the former origin');
  near(VS.getPlaneExtentUnits(), 1.5, 0, 'raw frame: 1.5 units across');
  v2.setTimepointTransform(M_LATE.toArray());
  VS.renderHighRes(64);
  assert.equal(renders.at(-1).defines.VOLUME_WARP, 1, 'warped again');
  near(VS.getPlaneExtentUnits(), 2 * E, 0, 'getPlaneExtentUnits() reads the linked material');

  // Foreign (explicit-spec) renders: one cached program per source AND warp state.
  const spec = { mode: 'oblique', value: 0.3, yaw: 0, pitch: 0, roll: 20, slabThickness: 5, slabStepNorm: 1 / 58, projection: 'mip' };
  VS.renderWithMaterial(src, spec, 64);
  const f1 = renders.at(-1);
  assert.equal(f1.defines.VOLUME_WARP, 1, 'foreign colour render: warped');
  VS.renderWithMaterial(src, spec, 64);
  assert.equal(renders.at(-1).material, f1.material, 'cached while nothing changes');
  v2.setTimepointTransform(null);
  VS.renderWithMaterial(src, spec, 64);
  assert.notEqual(renders.at(-1).material, f1.material, 'the warp toggle rebuilds the cached program');
  assert.equal(renders.at(-1).defines.VOLUME_WARP, undefined);
  v2.setTimepointTransform(M_LATE.toArray());
  const raw = VS.renderRawWithMaterial(src, spec, 64);
  assert.ok(raw, 'raw render');
  assert.equal(renders.at(-1).defines.VOLUME_WARP, 1, 'raw render: warped');
  assert.equal(renders.at(-1).defines.RAW_OUTPUT, 1);
  v2.setTimepointTransform(null);
  VS.renderRawWithMaterial(src, spec, 64);
  assert.equal(renders.at(-1).defines.VOLUME_WARP, undefined, 'raw render: the toggle rebuilds it too');
  v2.setTimepointTransform(M_LATE.toArray());
  VS.releaseForeign();

  // The native pass's throwaway material (viewer.js, run as written): VOLUME_WARP and a
  // frozen copy of this timepoint's warp and display box.
  const start = VIEWER.indexOf('    const tempMaterial = sourceMaterial.clone();');
  const end = VIEWER.indexOf('\n    }\n', VIEWER.indexOf("for (const k of ['volumeWarp', 'clipBoxMin', 'clipBoxSize'])", start)) + 7;
  assert.ok(start > 0 && end > start, 'the native pass builds its throwaway material from the source');
  const temp = vm.runInContext(`(sourceMaterial) => {\n${VIEWER.slice(start, end)}\nreturn tempMaterial; }`, ctx, { filename: 'viewer.js#tempMaterial' })(src);
  assert.equal(temp.defines.VOLUME_WARP, 1, 'the throwaway material samples through the warp');
  assert.notEqual(temp.uniforms.volumeWarp, src.uniforms.volumeWarp, 'its own uniform');
  assert.deepEqual(plain(temp.uniforms.volumeWarp.value.elements), plain(src.uniforms.volumeWarp.value.elements), 'the matrix of the timepoint on screen');
  const frozen = VolumeSlicer.samplingSpace(temp);
  v2.setTimepointTransform(M_MID.toArray());
  assert.deepEqual(plain(VolumeSlicer.samplingSpace(temp).warp.elements), plain(frozen.warp.elements), 'frozen while the pass runs');
  assert.notDeepEqual(plain(VolumeSlicer.samplingSpace(src).warp.elements), plain(frozen.warp.elements));
  console.log('plumbing (define follows the source, linked warp, foreign caches, native throwaway): OK');
}

// ── 8. The slice tool reaches the whole display box ────────────────────────────
// The plane's value used to sweep object depth [−½, ½] along its normal — the
// acquisition box — while a late timepoint's data lies in a display box ~3.6 object
// units deep: an XY cut could not reach half of the specimen the 3D view and the
// z-stack browser show. The value now sweeps the display box (VolumeSlicer.planeSweep,
// the clip sliders' own mapping on the axes), and VolumeViewer draws, rotates, drags
// and places its cut plane with that same map (volume-viewer.js, run as written).
{
  const liftAny = (src, name) => {
    const start = src.indexOf(`\n  function ${name}(`);
    assert.ok(start >= 0, `${name} is defined at module level in volume-viewer.js`);
    return src.slice(start, src.indexOf('\n  }\n', start) + 5);
  };
  const makeCutPlane = (mat) => vm.runInContext(`(() => {
    const material = mat;
    let _planeSpec = { mode: 'xy', value: 0.5, yaw: 0, pitch: 0, roll: 0, slabThickness: 1, projection: 'single' };
    // cube.scale: the physical proportions, one unit = the longest x/y extent (y here).
    const cube = { scale: new THREE.Vector3(${PHYSICAL.x / PHYSICAL.y}, 1, ${PHYSICAL.z / PHYSICAL.y}),
                   quaternion: new THREE.Quaternion(), position: new THREE.Vector3() };
    const _cutPlaneMesh = { quaternion: new THREE.Quaternion(), position: new THREE.Vector3(), scale: new THREE.Vector3() };
    const _updateCutSlabFaces = () => {};
    const getPhysicalSize = () => (${JSON.stringify(PHYSICAL)});
    const placed = [];
    const setPlaneSpec = (spec) => { placed.push(spec); };
    ${['_finiteNumber', '_normalForPlaneSpec', '_orientationForPlaneSpec', '_planeSweep', '_planeDepth', '_planeValueAtDepth',
      '_syncCutPlaneToOrbit', '_obliqueSpecKeepingCenter', 'placePlaneAtPoint'].map((n) => liftAny(VOLUME, n)).join('\n')}
    return {
      set(spec) { _planeSpec = { ..._planeSpec, ...spec }; _syncCutPlaneToOrbit(); },
      // The mesh centre in object units (the cube is unrotated at the origin here).
      centre: () => _cutPlaneMesh.position.clone().divide(cube.scale),
      position: () => _cutPlaneMesh.position.clone(),
      scale: () => cube.scale.clone(),
      side: () => _cutPlaneMesh.scale.x,
      maxScale: () => Math.max(cube.scale.x, cube.scale.y, cube.scale.z),
      keepCentre: (angles) => _obliqueSpecKeepingCenter(angles),
      place: (point) => { placePlaneAtPoint(point); return placed.pop(); },
      sweep: () => _planeSweep(_planeSpec),
      normal: () => _normalForPlaneSpec(_planeSpec),
      depth: (spec) => _planeDepth(spec),
    };
  })()`, Object.assign(ctx, { mat }), { filename: 'volume-viewer.js#cut-plane' });

  const clip = vv.getClipSpace();
  const warpedPlane = makeCutPlane(material);
  // XY: value 0 and 1 are the display box's bottom and top, as for the clip slider.
  for (const value of [0, 0.25, 0.5, 1]) {
    warpedPlane.set({ mode: 'xy', value, yaw: 0, pitch: 0, roll: 0 });
    const zWant = clip.min.z + value * clip.size.z;
    near(warpedPlane.centre().z, zWant, 1e-12, `XY value ${value}: the mesh at object z = min + value·size`);
    near(VolumeSlicer.planeGeometry({ mode: 'xy', value }, PHYSICAL, space).origin.z, zWant, 1e-12, `XY value ${value}: the slicer samples that plane`);
    near(warpedPlane.centre().x, clip.min.x + clip.size.x / 2, 1e-12, 'the mesh is centred on the display box (x)');
    near(warpedPlane.centre().y, clip.min.y + clip.size.y / 2, 1e-12, '… (y)');
  }
  near(warpedPlane.sweep().slope, clip.size.z, 1e-12, 'a drag moves the value by depth / size.z (depthPerValue)');
  assert.ok(warpedPlane.side() >= 1.04 * clip.size.z * PHYSICAL.z / PHYSICAL.y - 1e-12, 'the mesh covers the display box');

  // The late timepoint's voxels: where they sit in object depth, and which an XY cut
  // can reach — every one now; about half before.
  const Winv = W.clone().invert();
  let total = 0, reachable = 0, reachableBefore = 0;
  for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) for (let k = 0; k < 24; k++) {
    const o = V((i + 0.5) / 24, (j + 0.5) / 24, (k + 0.5) / 24).applyMatrix4(Winv);
    total++;
    if (o.z >= clip.min.z && o.z <= clip.min.z + clip.size.z) reachable++;
    if (Math.abs(o.z) <= 0.5) reachableBefore++;
  }
  assert.equal(reachable, total, 'every voxel of the timepoint on screen lies in the depth an XY cut sweeps');
  assert.ok(reachableBefore < 0.6 * total, `the acquisition-box sweep reached ${(100 * reachableBefore / total).toFixed(1)} % of them`);

  // Oblique planes: the mesh lies on the plane the slicer samples, and a rotation keeps
  // the plane through the same point.
  for (const spec of [{ mode: 'oblique', value: 0.3, yaw: 25, pitch: 35, roll: 10 }, { mode: 'xz', value: 0.8 }, { mode: 'yz', value: 0.1 }]) {
    warpedPlane.set({ yaw: 0, pitch: 0, roll: 0, ...spec });
    const g = VolumeSlicer.planeGeometry(spec, PHYSICAL, space);
    const m = V(0, 0, 0).crossVectors(g.right, g.up).normalize();
    near(warpedPlane.centre().sub(g.origin).dot(m), 0, 1e-12, `${spec.mode}: the mesh lies on the sampled plane`);
    near(warpedPlane.centre().distanceTo(g.origin), 0, 1e-9, `${spec.mode}: both centred on the display box's projection`);
  }
  warpedPlane.set({ mode: 'oblique', value: 0.3, yaw: 25, pitch: 35, roll: 10 });
  const through = warpedPlane.normal().multiplyScalar(warpedPlane.depth({ mode: 'oblique', value: 0.3, yaw: 25, pitch: 35, roll: 10 }));
  const turned = warpedPlane.keepCentre({ yaw: 31, pitch: 30, roll: 10 });
  const turnedSpec = { mode: 'oblique', ...turned };
  const nTurned = VolumeSlicer.planeGeometry({ ...turnedSpec, value: 0.5 }, null).step;
  near(warpedPlane.depth(turnedSpec), through.dot(nTurned), 1e-12, 'a rotation keeps the plane through the same point');
  // Clicking a point places the XY plane through it.
  warpedPlane.set({ mode: 'xy', value: 0.5, yaw: 0, pitch: 0, roll: 0 });
  const placed = warpedPlane.place({ normalized: { x: 0.4, y: 0.6, z: 0.9 } });
  near(clip.min.z + placed.value * clip.size.z, 0.4, 1e-12, 'placePlaneAtPoint: the plane through the clicked object depth');

  // Unwarped: the mesh, the rotation and the placement exactly as before.
  for (const mat of [null, (() => { const vu = makeViewer(); vu.setStabilizationSpace(ACQ, UNION); return vu.material; })()]) {
    const plain = makeCutPlane(mat);
    for (const spec of [{ mode: 'xy', value: 0.37 }, { mode: 'yz', value: 0.9 }, { mode: 'oblique', value: 0.61, yaw: 25, pitch: 35, roll: 10 }]) {
      plain.set({ yaw: 0, pitch: 0, roll: 0, ...spec });
      const want = plain.normal().multiplyScalar(spec.value - 0.5).multiply(plain.scale());
      const got = plain.position().toArray();
      assert.ok(got.every((v, i) => v === want.getComponent(i)), `${spec.mode}: mesh at normal·(value − ½) ⊙ scale, exactly (${got} vs ${want.toArray()})`);
      assert.equal(plain.side(), (spec.mode === 'oblique' ? 1.45 : 1.04) * plain.maxScale(), `${spec.mode}: mesh size as before`);
    }
    const kept = plain.keepCentre({ yaw: 31, pitch: 30, roll: 10 });
    const centre = plain.normal().multiplyScalar(0.61 - 0.5);
    const nNext = VolumeSlicer.planeGeometry({ mode: 'oblique', yaw: 31, pitch: 30, roll: 10 }, null).step;
    assert.equal(kept.value, Math.min(1, Math.max(0, centre.dot(nNext) + 0.5)), 'rotation keeps the former value');
    plain.set({ mode: 'xz', value: 0.5, yaw: 0, pitch: 0, roll: 0 });
    assert.equal(plain.place({ normalized: { x: 0.1, y: 0.3, z: 0.7 } }).value, 0.3, 'placement: the coordinate itself');
    assert.equal(plain.sweep(), null, 'no sweep: depth = value − ½');
  }
  console.log(`slice tool on a stabilised timelapse: the value sweeps the display box (XY reach ${(100 * reachableBefore / total).toFixed(1)} % → 100 % of the timepoint's voxels), mesh = sampled plane: OK`);
}

// ── 7. Unwarped: the former geometry, spec and picks, number for number ────────
{
  // planeGeometry of v1.56.0, transcribed.
  function formerGeometry(spec, physical) {
    const s = spec || {};
    const yaw = THREE.MathUtils.degToRad(s.yaw || 0), pitch = THREE.MathUtils.degToRad(s.pitch || 0), roll = THREE.MathUtils.degToRad(s.roll || 0);
    let normal, right, up;
    if (s.mode === 'xz') { normal = V(0, 1, 0); right = V(1, 0, 0); up = V(0, 0, 1); }
    else if (s.mode === 'yz') { normal = V(1, 0, 0); right = V(0, 1, 0); up = V(0, 0, 1); }
    else if (s.mode === 'oblique') {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, -yaw, roll, 'YXZ'));
      normal = V(0, 0, 1).applyQuaternion(q).normalize(); right = V(1, 0, 0).applyQuaternion(q).normalize(); up = V(0, 1, 0).applyQuaternion(q).normalize();
    } else { normal = V(0, 0, 1); right = V(1, 0, 0); up = V(0, 1, 0); }
    const value = Number.isFinite(+s.value) ? +s.value : 0.5;
    const origin = normal.clone().multiplyScalar(value - 0.5);
    const px = physical && physical.x > 0 ? physical.x : 1, py = physical && physical.y > 0 ? physical.y : 1, pz = physical && physical.z > 0 ? physical.z : 1;
    const maxP = Math.max(px, py, pz) || 1;
    const scale = V(maxP / px, maxP / py, maxP / pz);
    right.multiply(scale); up.multiply(scale);
    const step = normal.clone().multiply(scale);
    const texNormal = V(normal.x / scale.x, normal.y / scale.y, normal.z / scale.z);
    const len = texNormal.length() || 1;
    texNormal.divideScalar(len);
    const projMode = s.projection === 'mip' ? 1 : s.projection === 'average' ? 2 : 0;
    const steps = Math.max(1, Math.min(1024, Math.round(+s.slabThickness) || 1));
    let delta = steps > 1 ? 1 / 256 : 0;
    const sn = +s.slabStepNorm;
    if (steps > 1 && Number.isFinite(sn) && sn > 0) delta = sn / (step.length() || 1);
    const projected = steps > 1 && projMode !== 0;
    return { origin, center: origin.clone().addScalar(0.5), right, up, step, normal: texNormal, steps, delta, projMode, projected, halfThickness: projected ? ((steps - 1) * delta * 0.5) / len : 0 };
  }
  const specs = [
    {}, { mode: 'xy', value: 0.3 }, { mode: 'xz', value: 0.75 }, { mode: 'yz', value: 0 },
    { mode: 'oblique', value: 0.4, yaw: 30, pitch: 20, roll: 10, slabThickness: 9, projection: 'average' },
    { mode: 'oblique', value: 0.6, yaw: 180, pitch: 0, roll: 77, slabThickness: 5, slabStepNorm: 1 / 58, projection: 'mip' },
  ];
  for (const spec of specs) {
    for (const physical of [PHYSICAL, null, { x: 0, y: 3, z: -1 }]) {
      const want = formerGeometry(spec, physical);
      for (const got of [VolumeSlicer.planeGeometry(spec, physical), VolumeSlicer.planeGeometry(spec, physical, null),
        VolumeSlicer.planeGeometry(spec, physical, VolumeSlicer.samplingSpace({ defines: {}, uniforms: {} }))]) {
        for (const k of Object.keys(want)) {
          assert.deepEqual(plain(got[k]), plain(want[k]), `${JSON.stringify(spec)}: ${k} unchanged`);
        }
        assert.equal(got.extent, 0.75);
        assert.equal(got.warped, false);
      }
    }
  }
  // The z-stack spec: the former one, term for term, when the clip space is the unit
  // box (no warp) or when VolumeViewer has no getClipSpace at all.
  const vu = makeViewer();
  vu.setStabilizationSpace(ACQ, UNION); // geometry enlarged, but no timepoint warp: raw frame
  const unwarpedStub = { ...viewerStub, getClipSpace: () => vu.getClipSpace(), getMaterial: () => vu.material };
  const noApiStub = { getScreenFrameInVolume: () => screen, getPhysicalSize: () => PHYSICAL };
  for (const stub of [unwarpedStub, noApiStub]) {
    const s = page(stub, VolumeSlicer, { z: () => zDepth, range: () => sliceRange });
    for (const f of [{ right: V(1, 0, 0), up: V(0, 1, 0) }, { right: V(-1, 0, 0), up: V(0, 1, 0) }]) {
      screen = f;
      for (const r of [{ lo: 3, hi: 3 }, { lo: 10, hi: 14 }]) {
        sliceRange = r;
        const n = r.hi - r.lo + 1;
        const c = (r.lo + n / 2) / zDepth;
        const back = f.right.x < 0;
        const got = s.spec();
        assert.equal(got.value, back ? 1 - c : c, 'value as before');
        assert.equal(got.slabThickness, n);
        assert.equal(got.slabStepNorm, 1 / zDepth);
        assert.equal(got.projection, n > 1 ? 'mip' : 'single');
      }
    }
    assert.equal(s.pixel({ mode: 'xy' }, 1500).x, (1.5 * PHYSICAL.y) / 1500, 'pixel size as before');
    assert.equal(s.renderSize({ mode: 'xy' }, DIMS0), Math.ceil(1024 * 1.5), 'render size as before');
  }
  // The brick picker: the same picks with an unwarped material as with none.
  const dims = { x: 115, y: 128, z: 58, brickSize: 16 };
  for (const spec of [{ mode: 'xy', value: 0.64 }, { mode: 'oblique', value: 0.5, yaw: 30, pitch: 20, roll: 0 }]) {
    assert.deepEqual(plain(picker(dims, vu.material)(spec)), plain(picker(dims, null)(spec)), `${spec.mode}: unwarped picks unchanged`);
  }
  console.log('unwarped: geometry, z-stack spec, pixel/render size and picks unchanged: OK');
}

console.log('slicer on a stabilised timelapse (warp, display frame, native bricks): OK');
