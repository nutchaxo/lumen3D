// The viewer's quality select (viewer.js _updateQualityOptionLabels) and every
// quality → level mapping of the page go through the RENDERER's rule
// (VolumeViewer.getQualityLevels), so the select, its labels, the Compare footprints
// and the load agree with what the renderer really loads. Covered, with the real
// renderer functions lifted from volume-viewer.js:
//   • a v3 tree (SPEC §13.7): "512x512" = the finest level with max(x, y) ≤ 768,
//     "1024x1024" ≤ 1536, "native" = level 0; one option per level (native wins level
//     0, 512 the default before 1024), labelled with the level's real dimensions;
//   • a v2 tree: one option per level the power-of-two keys reach (the renderer's
//     nearest-level rule), finest first;
//   • _lodForQuality / _qualityValueForLod agree with the renderer both ways;
//   • a quality landing on another option's level selects that option; an unknown one
//     falls back to 512.
//
// Run: node tests/js/test_v3_page_quality_levels.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.mjs';

const pageSrc = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const vvSrc = readFileSync(path.join(ROOT, 'js/viewers/volume-viewer.js'), 'utf8').replace(/\r\n/g, '\n');
function lift(src, name) {
  const m = src.match(new RegExp(`\\n  function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?\\n  \\}\\n`));
  assert.ok(m, `${name}`);
  return m[0];
}
function liftConst(src, name) {
  const m = src.match(new RegExp(`\\n {2}const ${name} = [^\\n]+\\n`));
  assert.ok(m, `${name}`);
  return m[0];
}

assert.ok(!/V3_PRESET_MAX_XY/.test(pageSrc), 'the page keeps no quality rule of its own');

// The renderer's getQualityLevels over a mounted manifest (BrickLoader stub).
function renderer(mounted) {
  const body = `
    const BrickLoader = { getManifest: () => env.mounted };
    ${['getQualityLevels', '_isV3Manifest', '_lodForQuality', '_normalizeQualityKey'].map(n => lift(vvSrc, n)).join('\n')}
    return { getQualityLevels, lodFor: (q, m) => _lodForQuality(_normalizeQualityKey(q), m.levels.length, m.levels, _isV3Manifest(m)) };
  `;
  return new Function('env', body)({ mounted });
}

function page({ manifest, quality = '512x512', withRenderer = true }) {
  const select = {
    options: [], value: '',
    set innerHTML(v) { this.options = []; },
    appendChild(o) { this.options.push(o); }
  };
  const document = {
    getElementById: (id) => (id === 'select-quality' ? select : null),
    createElement: () => ({ value: '', textContent: '' })
  };
  const rv = renderer(manifest);
  const VolumeViewer = withRenderer ? { getQualityLevels: rv.getQualityLevels } : {};
  const body = `
    let _brickManifest = env.manifest;
    let _qualityMode = env.quality;
    const datasetMeta = null;
    function _t(k, f) { return f; }
    ${liftConst(pageSrc, 'QUALITY_KEYS_V3')}
    ${liftConst(pageSrc, 'QUALITY_KEYS_V2')}
    ${['_isV3BrickManifest', '_rendererQualityLevels', '_qualityLevels', '_updateQualityOptionLabels', '_qualityValueForLod', '_lodForQuality', '_showQualityInSelect',
      '_normalizeQualityParam', '_qualityDimsLabel', '_qualityDims'].map(n => lift(pageSrc, n)).join('\n')}
    return { update: _updateQualityOptionLabels, levels: _qualityLevels, lodFor: _lodForQuality, valueFor: _qualityValueForLod, show: _showQualityInSelect };
  `;
  const api = new Function('env', 'document', 'VolumeViewer', body)({ manifest, quality }, document, VolumeViewer);
  return { api, select, rv };
}

// A v3 pyramid of the 5735² reference dataset (X, Y halved; Z halved once XY catch up).
const v3Levels = [
  [5735, 5735, 172], [2868, 2868, 172], [1434, 1434, 86], [717, 717, 43], [359, 359, 22], [180, 180, 11], [90, 90, 6]
].map(([x, y, z], level) => ({ level, dimensions: { x, y, z } }));
const v3 = { schema: 'iribhm-bricks-v3', version: 3, levels: v3Levels };

{
  const { api, select, rv } = page({ manifest: v3 });
  api.update();
  assert.deepEqual(select.options.map(o => [o.value, o.textContent]), [
    ['native', 'Native (5735x5735x172)'],
    ['1024x1024', '1024 (1434x1434x86)'],
    ['512x512', '512 (717x717x43)']
  ], 'the SPEC §13.7 presets, labelled with the real dimensions');
  assert.equal(select.value, '512x512');
  for (const q of ['512x512', '1024x1024', 'native', '256x256']) {
    assert.equal(api.lodFor(q), rv.lodFor(q, v3), `${q}: the page loads the renderer's level`);
  }
  assert.equal(api.lodFor('512x512'), 3);
  assert.equal(api.lodFor('1024x1024'), 2);
  assert.equal(api.valueFor(3), '512x512');
  assert.equal(api.valueFor(2), '1024x1024');
  assert.equal(api.valueFor(0), 'native');
  assert.equal(api.valueFor(1), null, 'a level no preset maps to');
  // A small dataset: every preset lands on level 0 — native alone.
  const small = { schema: 'iribhm-bricks-v3', levels: [{ level: 0, dimensions: { x: 700, y: 600, z: 40 } }, { level: 1, dimensions: { x: 350, y: 300, z: 40 } }] };
  const s = page({ manifest: small, quality: '1024x1024' });
  s.api.update();
  assert.deepEqual(s.select.options.map(o => o.value), ['native'], 'level 0 fits both presets: native alone');
  assert.equal(s.select.value, 'native', '1024 lands on level 0: the native option is selected');
  const mid = { schema: 'iribhm-bricks-v3', levels: [{ level: 0, dimensions: { x: 1400, y: 1200, z: 80 } }, { level: 1, dimensions: { x: 700, y: 600, z: 80 } }] };
  const m = page({ manifest: mid, quality: '1024x1024' });
  m.api.update();
  assert.deepEqual(m.select.options.map(o => o.value), ['native', '512x512'], 'the 1024 preset is native itself: native + 512');
  assert.equal(m.select.value, 'native', '1024 shows as the option of its level');
  // A host asking for "1024x1024" (SET_QUALITY) on that tree: the native option shows.
  m.api.show(m.select, '1024x1024');
  assert.equal(m.select.value, 'native', 'a quality is shown as the option of its level');
  m.api.show(m.select, '512x512');
  assert.equal(m.select.value, '512x512');
  const odd = page({ manifest: mid, quality: 'bogus' });
  odd.api.update();
  assert.equal(odd.select.value, '512x512', 'an unknown quality falls back to 512');
  console.log('v3 presets (SPEC §13.7) from the renderer, real dimensions: OK');
}

{
  const v2Levels = [[3789, 3789, 257], [1895, 1895, 257], [948, 948, 257], [474, 474, 257]]
    .map(([x, y, z], level) => ({ level, dimensions: { x, y, z } }));
  const v2 = { schema: 'iribhm-bricks-v2', levels: v2Levels };
  const { api, select, rv } = page({ manifest: v2 });
  api.update();
  assert.deepEqual(select.options.map(o => [o.value, o.textContent]), [
    ['native', 'Native (3789x3789x257)'], ['2048x2048', '2048 (1895x1895x257)'], ['1024x1024', '1024 (948x948x257)'], ['512x512', '512 (474x474x257)']
  ], 'a v2 tree: one option per level, finest first');
  for (const q of ['256x256', '512x512', '1024x1024', '2048x2048', 'native']) {
    assert.equal(api.lodFor(q), rv.lodFor(q, v2), `${q}: v2 agrees with the renderer`);
  }
  assert.equal(api.lodFor('512x512'), 3, 'v2: the nearest level');
  assert.equal(api.valueFor(3), '512x512');
  console.log('v2 trees through the renderer: OK');
}

{
  // Without the renderer's API (nothing mounted): the static options stay, labelled
  // from the metadata, and no level is invented.
  const { api, select } = page({ manifest: null, withRenderer: false });
  select.options = ['256x256', '512x512', '1024x1024', 'native'].map(value => ({ value, textContent: value }));
  api.update();
  assert.equal(select.options.length, 4);
  assert.equal(select.value, '512x512');
  assert.equal(api.lodFor('512x512'), 0);
  console.log('no renderer levels: static options kept: OK');
}

console.log('quality select labels: OK');
