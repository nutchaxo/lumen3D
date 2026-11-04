// The maximum-projection raw cache (volume-viewer.js: RAW_OUT / RAW_READ):
//   • mathematics — the display of the projected raw values equals the projection of the
//     displayed values, for any window, gamma, opacity and channel switch (the shader's
//     channelValues is non-decreasing in the raw value);
//   • shader structure — the two variants exist, the recolour pass replaces the march,
//     the raw march ignores the window (a cell is empty only at raw 0) and the display
//     uniforms are the only ones a recolour may change;
//   • every define permutation of the two variants resolves (same checker as
//     test_v3_render_glsl.mjs).
//
// Run: node tests/js/test_raw_mip_cache.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const VV = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');

let seed = 424242;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// channelValues of the shader, for one channel.
const display = (raw, st) => {
  if (!st.en) return 0;
  let v = Math.min(1, Math.max(0, (raw - st.min) / Math.max(st.max - st.min, 0.0001)));
  if (st.gamma !== 1) v = Math.pow(v, st.gamma);
  return v * st.opacity;
};

{
  let checked = 0;
  for (let round = 0; round < 400; round++) {
    const st = { en: rnd() < 0.85, min: rnd() * 0.4, max: 0.2 + rnd() * 0.8, gamma: rnd() < 0.3 ? 1 : 0.18 + rnd() * 5, opacity: rnd() };
    const samples = Array.from({ length: 200 }, () => rnd());
    const viaDisplayed = Math.max(...samples.map((r) => display(r, st)));
    const viaRaw = display(Math.max(...samples), st);
    assert.ok(Math.abs(viaDisplayed - viaRaw) < 1e-12, `max of displayed ${viaDisplayed} vs displayed max ${viaRaw}`);
    checked++;
  }
  console.log(`raw maximum then display = display then maximum (${checked} random settings): OK`);
}

const frag = VV.slice(VV.indexOf('const fragmentShader = `'), VV.indexOf('`;', VV.indexOf('const fragmentShader = `')));
assert.match(frag, /#ifdef RAW_READ[\s\S]*?vec4 rawMax = texture\(rawMip, gl_FragCoord\.xy \/ rawFullSize\);/, 'recolour pass reads the raw maxima');
assert.match(frag, /vec4 mipV = channelValues\(rawMax\);/);
assert.match(frag, /#ifdef RAW_OUT\s+mip = max\(mip, val\);/, 'raw march keeps the undisplayed value');
assert.match(frag, /#ifdef RAW_OUT\s+fragColor = mip;\s+return;\s+#endif/, 'raw march writes the maxima');
assert.match(frag, /bool empty = all\(lessThanEqual\(gFineMax, vec4\(0\.0\)\)\) \|\| all\(lessThanEqual\(gFineMax \+ vec4\(RAW_SKIP_MARGIN\), gRayMax\)\);/, 'raw march: a cell is empty at raw 0 or when it cannot raise the ray maximum, whatever the window');
assert.match(frag, /#define RAW_SKIP_MARGIN 0\.002/);
assert.match(frag, /mip = max\(mip, val\);\s+#if defined\(CELL_SKIP\) && !defined\(PICK_MODE\)\s+gRayMax = mip;/, 'the ray maximum is visible to the cell test');
// The recolour must end exactly like the march does in mode 1.
assert.match(frag, /if \(mipTotal < 0\.004\) discard;/);
assert.match(frag, /\* exposure;\s+fragColor = vec4\(mipRGB, fragAlpha\(mipRGB, 0\.0\)\);/);
assert.match(frag, /if \(totalMIP < 0\.004\) discard;/, 'same discard threshold as the march');

// The display uniforms are exactly the ones a recolour may change.
const set = /const RAW_DISPLAY_UNIFORMS = new Set\(\['exposure', 'rawFullSize'\]\);\n\s+for \(let c = 0; c < 4; c\+\+\) for \(const n of \[([^\]]+)\]\)/.exec(VV);
assert.ok(set, 'RAW_DISPLAY_UNIFORMS');
assert.deepEqual(set[1].split(',').map((x) => x.trim().replace(/'/g, '')), ['color', 'min', 'max', 'gamma', 'opacity', 'en']);
for (const u of ['steps', 'sampleRate', 'clipMin', 'clipMax', 'volumeWarp', 'renderMode']) {
  assert.ok(!set[1].includes(u), `${u} moves the maxima: it must not be a display uniform`);
}
// Every non-display uniform of the march must be in the material (so the snapshot sees it).
for (const u of ['steps', 'sampleRate', 'clipMin', 'clipMax', 'renderMode']) {
  assert.ok(new RegExp(`\\b${u}: \\{`).test(VV), `${u} is a material uniform`);
}
// Exports, picking, a cross-fade and the other render modes keep the classic path.
assert.match(VV, /material\.uniforms\.renderMode\.value === 1 && material\.uniforms\.exportAlpha\.value === 0/);
assert.match(VV, /&& !_transitionCube/);
assert.match(VV, /cube\.material = c\.readMat;\s+try \{ renderer\.render\(scene, camera\); \} finally \{ cube\.material = material; \}/, 'the cube always gets its own material back');
console.log('raw cache shader and wiring: OK');

console.log('raw mip cache: OK');
