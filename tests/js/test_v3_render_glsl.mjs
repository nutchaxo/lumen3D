// Static checks of the ray-march and slice shaders under EVERY define permutation the
// viewer can produce (web 1.59.0: v3 bordered atlases, R8 / RG8 atlases, region-of-
// interest detail atlas). No GLSL compiler runs under Node, so each permutation is
// preprocessed exactly as a GLSL ES 3.00 compiler does (three.js prepends the
// material's defines as `#define NAME value`; an undefined identifier inside #if is an
// error, it does not read as 0), then checked:
//   • balanced (), [], {}; every #if closed;
//   • every identifier resolves: a GLSL keyword, type or built-in, a three.js built-in
//     uniform, a macro, a global, a parameter or a local of the enclosing function
//     declared BEFORE its use — so a variable or uniform used in a define branch that
//     does not declare it is caught;
//   • active samplers (declared AND referenced) ≤ 16 (MAX_TEXTURE_IMAGE_UNITS of
//     WebGL 2), the eight base pages + page table + four detail pages + detail table;
//   • no function is defined twice, every called user function is defined.
// v2 / v3 is not a define: it is the slotStride / brickApron uniforms (and the atlas
// filter); both are covered by every permutation, and the address arithmetic itself
// is proven numerically in test_v3_render_trilinear.mjs.
//
// Run: node tests/js/test_v3_render_glsl.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function extract(src, startMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, `shader ${startMarker} found`);
  const from = i + startMarker.length;
  const end = src.indexOf('\n  `;', from);
  assert.ok(end > from, 'shader end found');
  return src.slice(from, end);
}

const VIEWER_FRAG = extract(read('js/viewers/volume-viewer.js'), 'const fragmentShader = `').replace('${MAX_MARCH_STEPS}', '4096');
const SLICER_FRAG = extract(read('js/viewers/volume-slicer.js'), 'const FRAG = `');
assert.ok(!/\$\{/.test(VIEWER_FRAG) && !/\$\{/.test(SLICER_FRAG), 'no template interpolation left in the shaders');

// ── GLSL ES 3.00 vocabulary ──────────────────────────────────────────────────
const TYPES = new Set(('void bool int uint float vec2 vec3 vec4 bvec2 bvec3 bvec4 ivec2 ivec3 ivec4 uvec2 uvec3 uvec4 ' +
  'mat2 mat3 mat4 mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 ' +
  'sampler2D sampler3D samplerCube sampler2DShadow samplerCubeShadow sampler2DArray sampler2DArrayShadow ' +
  'isampler2D isampler3D isamplerCube isampler2DArray usampler2D usampler3D usamplerCube usampler2DArray').split(' '));
const KEYWORDS = new Set(('const uniform layout centroid flat smooth break continue do for while switch case default if else ' +
  'in out inout true false invariant discard return lowp mediump highp precision struct').split(' '));
const BUILTINS = new Set(('radians degrees sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh pow exp log exp2 log2 ' +
  'sqrt inversesqrt abs sign floor trunc round roundEven ceil fract mod modf min max clamp mix step smoothstep isnan isinf ' +
  'floatBitsToInt floatBitsToUint intBitsToFloat uintBitsToFloat length distance dot cross normalize faceforward reflect ' +
  'refract matrixCompMult outerProduct transpose determinant inverse lessThan lessThanEqual greaterThan greaterThanEqual ' +
  'equal notEqual any all not textureSize texture textureProj textureLod textureOffset texelFetch texelFetchOffset ' +
  'textureProjOffset textureLodOffset textureProjLod textureGrad dFdx dFdy fwidth ' +
  'gl_FragCoord gl_FrontFacing gl_FragDepth gl_PointCoord').split(' '));
// What three.js r147 declares in front of a GLSL3 ShaderMaterial's fragment shader.
const THREE_FRAGMENT = new Set(['viewMatrix', 'cameraPosition', 'isOrthographic']);
const SAMPLER = /^[iu]?sampler/;

// ── Preprocessor ─────────────────────────────────────────────────────────────
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

function evalIf(expr, macros) {
  // Tokens: defined(X) / defined X, integers, macro names (replaced by their value),
  // operators. Any other identifier is an error (GLSL ES 3.00 §3.4).
  const toks = expr.match(/defined|[A-Za-z_]\w*|\d+|&&|\|\||==|!=|<=|>=|[!<>+\-*/()]/g) || [];
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'defined') {
      let name = toks[i + 1];
      if (name === '(') { name = toks[i + 2]; i += 3; } else i += 1;
      out.push(macros.has(name) ? '1' : '0');
    } else if (/^[A-Za-z_]/.test(t)) {
      if (!macros.has(t)) throw new Error(`undefined identifier "${t}" in #if ${expr}`);
      const v = String(macros.get(t)).trim();
      if (!/^-?\d+$/.test(v)) throw new Error(`macro ${t} = "${v}" is not an integer in #if`);
      out.push(v);
    } else out.push(t);
  }
  // eslint-disable-next-line no-new-func
  return Boolean(Function(`return (${out.join(' ')}) ? 1 : 0;`)());
}

function preprocess(src, defines) {
  const macros = new Map(Object.entries(defines).map(([k, v]) => [k, String(v)]));
  const stack = [];   // { active, taken, parentActive }
  const lines = stripComments(src).split('\n');
  const out = [];
  const active = () => stack.every(s => s.active);
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^#\s*(\w+)\s*(.*)$/.exec(line);
    if (!m) { out.push(active() ? raw : ''); continue; }
    const [, dir, rest] = m;
    const parentActive = active();
    if (dir === 'ifdef' || dir === 'ifndef') {
      const has = macros.has(rest.trim());
      const cond = dir === 'ifdef' ? has : !has;
      stack.push({ active: parentActive && cond, taken: cond, parentActive });
    } else if (dir === 'if') {
      const cond = parentActive ? evalIf(rest, macros) : false;
      stack.push({ active: parentActive && cond, taken: cond, parentActive });
    } else if (dir === 'elif') {
      const top = stack[stack.length - 1];
      if (!top) throw new Error('#elif without #if');
      const cond = !top.taken && top.parentActive ? evalIf(rest, macros) : false;
      top.active = top.parentActive && cond;
      top.taken = top.taken || cond;
    } else if (dir === 'else') {
      const top = stack[stack.length - 1];
      if (!top) throw new Error('#else without #if');
      top.active = top.parentActive && !top.taken;
      top.taken = true;
    } else if (dir === 'endif') {
      if (!stack.pop()) throw new Error('#endif without #if');
    } else if (dir === 'define') {
      if (parentActive) {
        const d = /^(\w+)\s*(.*)$/.exec(rest);
        macros.set(d[1], d[2] || '');
      }
    } else if (dir === 'undef') {
      if (parentActive) macros.delete(rest.trim());
    } else if (!['version', 'extension', 'pragma', 'line', 'error'].includes(dir)) {
      throw new Error(`unknown directive #${dir}`);
    }
    out.push('');
  }
  if (stack.length) throw new Error('unterminated #if');
  // Object-like macro substitution in the code.
  const code = out.join('\n').replace(/[A-Za-z_]\w*/g, (id) => (macros.has(id) && macros.get(id) !== '' ? macros.get(id) : id));
  return { code, macros };
}

// ── Checker ──────────────────────────────────────────────────────────────────
function tokenize(code) {
  const re = /([A-Za-z_]\w*)|(\d+\.?\d*(?:[eE][+-]?\d+)?[uU]?|\.\d+(?:[eE][+-]?\d+)?)|(\S)/g;
  const toks = [];
  let m;
  while ((m = re.exec(code))) toks.push(m[1] ? { t: 'id', v: m[1] } : m[2] ? { t: 'num', v: m[2] } : { t: 'p', v: m[3] });
  return toks;
}

function check(code, macros) {
  const errors = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const st = [];
  for (const ch of code) {
    if (pairs[ch]) st.push(pairs[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') { if (st.pop() !== ch) { errors.push(`unbalanced ${ch}`); break; } }
  }
  if (st.length) errors.push('unclosed delimiter');

  const toks = tokenize(code);
  const globals = new Set();
  const functions = new Map();    // name -> count
  const samplers = new Map();     // name -> uses
  const calls = [];
  const known = (name, scope) => TYPES.has(name) || KEYWORDS.has(name) || BUILTINS.has(name) || THREE_FRAGMENT.has(name)
    || macros.has(name) || globals.has(name) || functions.has(name) || scope.has(name);
  let depth = 0;
  let fnScope = null;       // Set of params + locals declared so far
  let parenDepth = 0;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'p') {
      if (tk.v === '{') depth++;
      else if (tk.v === '}') { depth--; if (depth === 0) fnScope = null; }
      else if (tk.v === '(') parenDepth++;
      else if (tk.v === ')') parenDepth--;
      continue;
    }
    if (tk.t !== 'id') continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev && prev.t === 'p' && prev.v === '.') continue;   // swizzle / member
    // Declaration: TYPE NAME followed by ; = , ) [ (
    if (TYPES.has(tk.v) && next && next.t === 'id' && !KEYWORDS.has(next.v)) {
      const after = toks[i + 2];
      const name = next.v;
      if (after && after.t === 'p' && after.v === '(' && depth === 0) {
        functions.set(name, (functions.get(name) || 0) + 1);
        // Parameters, up to the matching ')'.
        fnScope = new Set();
        let j = i + 3;
        let pd = 1;
        for (; j < toks.length && pd > 0; j++) {
          const p = toks[j];
          if (p.v === '(') pd++;
          else if (p.v === ')') pd--;
          else if (p.t === 'id' && TYPES.has(p.v) && toks[j + 1]?.t === 'id') fnScope.add(toks[j + 1].v);
        }
        // Skip validation of the parameter list itself.
        i = j - 1;
        parenDepth = 0;
        continue;
      }
      if (after && after.t === 'p' && [';', '=', ',', ')', '['].includes(after.v)) {
        if (depth === 0 && !fnScope) {
          globals.add(name);
          if (SAMPLER.test(tk.v)) samplers.set(name, 0);
        } else if (fnScope) fnScope.add(name);
        else globals.add(name);
        i += 1;   // the name is a declaration, not a use
        continue;
      }
    }
    if (next && next.t === 'p' && next.v === '(' && !TYPES.has(tk.v) && !BUILTINS.has(tk.v) && !KEYWORDS.has(tk.v)) {
      calls.push(tk.v);
    }
    if (samplers.has(tk.v)) samplers.set(tk.v, samplers.get(tk.v) + 1);
    if (!known(tk.v, fnScope || new Set())) errors.push(`unknown identifier "${tk.v}"`);
  }
  for (const [name, n] of functions) if (n > 1) errors.push(`function ${name} defined ${n} times`);
  for (const c of calls) if (!functions.has(c)) errors.push(`call to undefined function ${c}()`);
  const activeSamplers = [...samplers].filter(([, uses]) => uses > 0).map(([n]) => n);
  if (activeSamplers.length > 16) errors.push(`${activeSamplers.length} active samplers > 16: ${activeSamplers.join(', ')}`);
  return { errors: [...new Set(errors)], activeSamplers };
}

function* product(axes) {
  const keys = Object.keys(axes);
  const idx = keys.map(() => 0);
  for (;;) {
    const defines = {};
    keys.forEach((k, n) => { const v = axes[k][idx[n]]; if (v !== undefined) defines[k] = v; });
    yield defines;
    let p = keys.length - 1;
    while (p >= 0 && ++idx[p] === axes[keys[p]].length) { idx[p] = 0; p--; }
    if (p < 0) return;
  }
}

// ── The ray-march shader: every permutation ──────────────────────────────────
{
  const axes = {
    ENABLE_SVR: [undefined, 1],
    HAS_OCCUPANCY: [undefined, 1],
    SVR_COMPONENTS: [undefined, 1, 2],
    ROI_DETAIL: [undefined, 1],
    ROI_DETAIL_COMPONENTS: [undefined, 1, 2],
    VOLUME_WARP: [undefined, 1],
    PICK_MODE: [undefined, 1],
    ENABLE_CHANNEL_0: [0, 1],
    ENABLE_CHANNEL_1: [0, 1],
    ENABLE_CHANNEL_2: [0, 1],
    ENABLE_CHANNEL_3: [0, 1]
  };
  let n = 0;
  let maxSamplers = 0;
  const failures = [];
  for (const defines of product(axes)) {
    n++;
    let res;
    try {
      const { code, macros } = preprocess(VIEWER_FRAG, defines);
      res = check(code, macros);
    } catch (e) {
      res = { errors: [e.message], activeSamplers: [] };
    }
    maxSamplers = Math.max(maxSamplers, res.activeSamplers.length);
    if (res.errors.length) failures.push(`${JSON.stringify(defines)}: ${res.errors.join('; ')}`);
  }
  assert.equal(failures.length, 0, `ray-march shader permutations failing:\n${failures.slice(0, 10).join('\n')}`);
  assert.equal(n, 2 * 2 * 3 * 2 * 3 * 2 * 2 * 16, 'every permutation enumerated');
  assert.equal(maxSamplers, 14, 'the busiest permutation binds 8 base pages + page table + 4 detail pages + detail table');
  console.log(`ray-march shader: ${n} define permutations preprocess and resolve; ≤ ${maxSamplers} samplers: OK`);
}

// ── Targeted assertions on what each define must switch ──────────────────────
{
  const pp = (d) => preprocess(VIEWER_FRAG, { ENABLE_CHANNEL_0: 1, ENABLE_CHANNEL_1: 1, ENABLE_CHANNEL_2: 1, ENABLE_CHANNEL_3: 1, ...d });
  const { code: v2 } = pp({ ENABLE_SVR: 1 });
  assert.ok(/keepComponents\(sampleSVRAtlas\(slotCoord\(uvw \* volumeDim, cell, cachedPage\.xyz, volumeDim, slotStride, brickApron, atlasDim\), cachedPage\.w\), 4\)/.test(v2),
    'base SVR fetch: slotCoord with the slot stride and border, RGBA kept');
  assert.ok(!/detailPageTable/.test(v2), 'no detail sampler without ROI_DETAIL');
  const { code: r8 } = pp({ ENABLE_SVR: 1, SVR_COMPONENTS: 1 });
  assert.ok(/cachedPage\.w\), 1\)/.test(r8), 'an R8 atlas keeps one component');
  const { code: roi } = pp({ ENABLE_SVR: 1, ROI_DETAIL: 1, ROI_DETAIL_COMPONENTS: 2 });
  const f = roi.slice(roi.indexOf('bool fetchVoxel'), roi.indexOf('vec4 channelValues'));
  assert.ok(f.indexOf('detailPageTable') < f.indexOf('pageTable,'), 'the detail level is consulted before the base level');
  assert.ok(/detailPage\.w\), 2\)/.test(f), 'detail components follow ROI_DETAIL_COMPONENTS');
  assert.ok(/skip = min\(skip, brickExitIn\(uvw, dirTex, dCell, detailVolumeDim\)\)/.test(f), 'an empty base brick never skips past a detail cell');
  assert.ok(/nu = max\(nu, length\(dirTex \* detailVolumeDim\)\)/.test(roi), 'the march samples at the detail pitch');
  const { code: dense } = pp({ HAS_OCCUPANCY: 1, ROI_DETAIL: 1 });
  assert.ok(/textureLod\(svrAtlas0, uvw, 0\.0\)/.test(dense) && /detailPageTable/.test(dense), 'a dense base volume takes a detail atlas too');
  // Trilinear addressing (apron) and nearest addressing (no apron) — one function.
  const sc = VIEWER_FRAG.slice(VIEWER_FRAG.indexOf('vec3 slotCoord('), VIEWER_FRAG.indexOf('#ifdef ENABLE_SVR\n    uniform sampler3D pageTable'));
  assert.ok(/vec3 local = clamp\(pos - cell \* brickSize, vec3\(0\.0\), vec3\(brickSize\)\);\s*return \(slot \* stride \+ vec3\(apron\) \+ local\) \/ atlasSize;/.test(sc),
    'bordered: texel = slot·stride + 1 + (pos − 64·cell), local clamped to [0, 64]');
  assert.ok(/return \(slot \* stride \+ localVoxel \+ vec3\(0\.5\)\) \/ atlasSize;/.test(sc), 'unbordered: the voxel centre (nearest)');
  console.log('define switches (components, detail first, skip, pitch, addressing): OK');
}

// ── The slice shader: every permutation ──────────────────────────────────────
{
  const axes = { ENABLE_SVR: [undefined, 1], VOLUME_WARP: [undefined, 1], FALLBACK_TEX: [undefined, 1], RAW_OUTPUT: [undefined, 1], PLANE_TEX: [undefined, 1] };
  const failures = [];
  let n = 0;
  for (const defines of product(axes)) {
    n++;
    try {
      const { code, macros } = preprocess(SLICER_FRAG, defines);
      const res = check(code, macros);
      if (res.errors.length) failures.push(`${JSON.stringify(defines)}: ${res.errors.join('; ')}`);
    } catch (e) { failures.push(`${JSON.stringify(defines)}: ${e.message}`); }
  }
  assert.equal(failures.length, 0, `slice shader permutations failing:\n${failures.join('\n')}`);
  const { code } = preprocess(SLICER_FRAG, { ENABLE_SVR: 1 });
  assert.ok(/vec3 atlasVoxel = slotIndex \* slotStride \+ vec3\(brickApron\) \+ localVoxel;/.test(code), 'the slice reads the voxel inside a bordered slot');
  assert.ok(/return keepComponents\(sampleSVRAtlas\(atlasLookup\.xyz, atlasLookup\.w\)\);/.test(code), 'R8 / RG8 atlases read with absent channels at 0');
  console.log(`slice shader: ${n} define permutations: OK`);
}

// ── The checker catches what it claims to catch ──────────────────────────────
{
  // Using a detail uniform outside its define must be reported.
  const leaked = VIEWER_FRAG.replace('float nu = max(length(dirTex * volumeVoxels), 1e-6);', 'float nu = max(length(dirTex * detailVolumeDim), 1e-6);');
  const r1 = check(...Object.values(preprocess(leaked, { ENABLE_SVR: 1, ENABLE_CHANNEL_0: 1, ENABLE_CHANNEL_1: 1, ENABLE_CHANNEL_2: 1, ENABLE_CHANNEL_3: 1 })));
  assert.ok(r1.errors.some(e => /detailVolumeDim/.test(e)), 'a uniform used outside its define is caught');
  const r2 = check(...Object.values(preprocess(VIEWER_FRAG.replace('vec3 dCell = brickCellIn(uvw, detailVolumeDim);', ''), { ENABLE_SVR: 1, ROI_DETAIL: 1, ENABLE_CHANNEL_0: 1, ENABLE_CHANNEL_1: 1, ENABLE_CHANNEL_2: 1, ENABLE_CHANNEL_3: 1 })));
  assert.ok(r2.errors.some(e => /dCell/.test(e)), 'a local used without its declaration is caught');
  assert.throws(() => preprocess('#if UNDEFINED_THING\n#endif\n', {}), /undefined identifier/, 'an undefined identifier in #if is an error, as in GLSL ES');
  console.log('checker self-test: OK');
}
