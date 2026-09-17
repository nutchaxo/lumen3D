// What the admin Datasets tab calls the orientation arms and the default views.
//
// The arms carry no anatomical nomenclature of their own: an un-renamed arm is
// "Red 1 / Red 2" (±X), "Green 1 / Green 2" (±Y), "Blue 1 / Blue 2" (±Z), drawn
// R1/R2 · G1/G2 · B1/B2 on the gizmo, and a default-view option is built from
// the two arms it pins ("Blue 1 facing the camera, Green 1 up") — with the names
// the operator gave when an arm is renamed, so the two controls always speak the
// same vocabulary. The storage keys (R/L/A/P/V/D, preset ids) never surface.
//
// The module is loaded the way tests/js/test_admin_dirty_detection.mjs does, with
// the REAL English dictionary behind t() so the strings asserted are what an
// English-speaking operator reads.
//
// Run: node tests/js/test_admin_orientation_labels.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const EN = JSON.parse(read('lang/en.json'));
const tEn = (k, d, params) => {
  let v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), EN);
  if (typeof v !== 'string') return d ?? '';
  for (const [name, val] of Object.entries(params || {})) v = v.replace(new RegExp(`\\{${name}\\}`, 'g'), String(val));
  return v;
};

function stubEl() {
  return {
    value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    style: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    closest: () => stubEl(), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getAttribute: () => null,
    removeAttribute() {}, remove() {}, focus() {}, insertBefore() {}, appendChild() {},
  };
}

let src = read('js/pages/admin/tab-datasets.js')
  .replace(/^import\s[^;]*;/gm, '')
  .replace(/^export\s+(function|const|let|class)/gm, '$1');
src += `
;globalThis.__T = {
  mount(draft) {
    DOM = new Proxy({}, { get: (t, k) => (t[k] || (t[k] = stubEl())) });
    _draft = draft; _original = JSON.parse(JSON.stringify(draft));
    _current = { id: draft.id, path: draft.path, folderName: 'emb-1', hidden: false };
    _isCalibratingOrientation = false; _formBound = false;
    populateForm();
    clearDirty();
    return DOM;
  },
  rename: (code, name) => { writeOrientationCfg({ labels: { ...readOrientationCfg().labels, [code]: name } }); renderDefaultView(); },
  codes: () => AXIS_CODES.slice(),
  presets: () => VIEW_PRESETS.map((p) => p.slice()),
};`;
const ctx = vm.createContext({
  console, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, Boolean, Date, stubEl,
  API_DATASETS: 'api/datasets.php',
  Utils: { DATASET_TYPES: ['3d', '2d', 'live'], datasetTypeLabel: (x) => x, datasetPage: () => 'viewer.html' },
  t: tEn,
  escHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  apiFetch: async () => null, toast() {}, el: () => stubEl(),
  deepClone: (v) => JSON.parse(JSON.stringify(v)), refreshIcons() {},
  setUnsaved() {}, setDirtyGuard() {}, Upload: { subscribe() {} },
  window: { location: { origin: 'http://localhost' }, addEventListener() {} },
  document: { addEventListener() {} }, confirm: () => true,
});
vm.runInContext(src, ctx, { filename: 'tab-datasets.js' });
const T = ctx.__T;

const META = (orientationAxes) => ({
  id: '3d/emb-1', path: '3d/emb-1', type: '3d', name: 'Embryo 1', stage: 'E8.5',
  dimensions: { x: 64, y: 64, z: 32, c: 1 }, voxel_size: { x: 1, y: 1, z: 1 }, exposure: 1,
  channels: [{ name: 'DAPI', color: '#2F6BFF', min: 0, max: 1, gamma: 1, active: true }],
  orientationAxes,
});
const names = (html) => [...html.matchAll(/class="ori-axis-name">([^<]*)</g)].map((m) => m[1]);
const placeholders = (html) => [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
const options = (html) => [...html.matchAll(/<option value="([^"]*)">([^<]*)</g)].map((m) => [m[1], m[2]]);

// ── 1. Defaults: colour + suffix, RGB glyphs, in axis order ──────────────────
{
  const DOM = T.mount(META(undefined));
  assert.deepEqual(names(DOM.orientationAxesList.innerHTML),
    ['Red 1 (R1)', 'Red 2 (R2)', 'Green 1 (G1)', 'Green 2 (G2)', 'Blue 1 (B1)', 'Blue 2 (B2)'],
    'the six arms are listed by colour and suffix, glyph beside');
  assert.deepEqual(placeholders(DOM.orientationAxesList.innerHTML), ['R1', 'R2', 'G1', 'G2', 'B1', 'B2'],
    'an empty rename field shows the gizmo glyph');
  // Spread into this realm: a VM-born array has a foreign prototype for deepEqual.
  assert.deepEqual([...T.codes()], ['R', 'L', 'A', 'P', 'V', 'D'], 'storage keys stay R/L · A/P · V/D');
  for (const code of T.codes()) {
    assert.ok(!/\b(Anterior|Posterior|Ventral|Dorsal|Left|Right)\b/.test(DOM.orientationAxesList.innerHTML),
      `no anatomical default may leak (${code})`);
  }

  const opts = options(DOM.fDefaultView.innerHTML);
  assert.equal(opts[0][0], 'none');
  assert.equal(opts.at(-1)[0], 'custom', 'the custom (captured) option is kept');
  assert.equal(opts.at(-1)[1], EN.admin.viewCustom);
  assert.deepEqual(opts.slice(1, -1), [
    ['right', 'Red 1 facing the camera, Green 1 up'],
    ['left', 'Red 2 facing the camera, Green 1 up'],
    ['anterior', 'Green 1 facing the camera, Blue 2 up'],
    ['posterior', 'Green 2 facing the camera, Blue 2 up'],
    ['ventral', 'Blue 1 facing the camera, Green 1 up'],
    ['dorsal', 'Blue 2 facing the camera, Green 1 up'],
  ], 'every preset names the arm it faces and the arm it points up, in arm order');
}

// ── 2. The preset ids and pairs are the plugin's ─────────────────────────────
// The admin only labels; the quaternion comes from the plugin. A pair that drifts
// from ORI_VIEW_PRESETS would describe one pose and apply another.
{
  const plugin = read('js/modules/tools/orientation-axes/index.js');
  for (const [id, face, up] of T.presets()) {
    const re = new RegExp(`${id}:\\s*\\{\\s*face:\\s*'${face}',\\s*up:\\s*'${up}'\\s*\\}`);
    assert.ok(re.test(plugin), `preset ${id} (${face}→camera, ${up}→up) must match the plugin`);
  }
  assert.equal(T.presets().length, 6);
}

// ── 3. Renames flow into the presets and the list ────────────────────────────
{
  const DOM = T.mount(META({ labels: { A: 'Head', V: 'Belly' }, hidden: ['D'] }));
  assert.equal(names(DOM.orientationAxesList.innerHTML)[2], 'Green 1 (G1)', 'the list keeps the default name as the row title');
  const opts = Object.fromEntries(options(DOM.fDefaultView.innerHTML));
  assert.equal(opts.ventral, 'Belly facing the camera, Head up', 'a renamed arm is quoted by its new name');
  assert.equal(opts.right, 'Red 1 facing the camera, Head up');
  assert.equal(opts.anterior, 'Head facing the camera, Blue 2 up');

  T.rename('R', 'Tail');
  assert.equal(Object.fromEntries(options(DOM.fDefaultView.innerHTML)).right, 'Tail facing the camera, Head up',
    'typing a name re-labels the presets at once');
  T.rename('R', '   ');
  assert.equal(Object.fromEntries(options(DOM.fDefaultView.innerHTML)).right, 'Red 1 facing the camera, Head up',
    'a blank rename falls back to the default name');
}

// ── 4. The four dictionaries and the plugin glyphs agree ─────────────────────
{
  for (const code of ['en', 'fr', 'es', 'nl']) {
    const admin = JSON.parse(read(`lang/${code}.json`)).admin;
    for (const k of ['axisRed', 'axisGreen', 'axisBlue', 'viewPreset', 'viewNone', 'viewCustom', 'orientationFrame']) {
      assert.equal(typeof admin[k], 'string', `lang/${code}.json admin.${k}`);
    }
    assert.ok(admin.viewPreset.includes('{face}') && admin.viewPreset.includes('{up}'), `${code}: viewPreset carries both tokens`);
    for (const k of ['axisAnterior', 'axisLeft', 'viewVentral', 'viewPosterior']) {
      assert.equal(admin[k], undefined, `${code}: anatomical key ${k} is gone`);
    }
    const glyphs = JSON.parse(read(`js/modules/tools/orientation-axes/lang/${code}.json`));
    assert.deepEqual(
      ['R', 'L', 'A', 'P', 'V', 'D'].map((c) => glyphs['axis' + c]),
      ['R1', 'R2', 'G1', 'G2', 'B1', 'B2'], `${code}: gizmo glyphs`);
  }
}

console.log('admin orientation labels (colour+suffix defaults · presets from arms · renames · dictionaries): OK');
