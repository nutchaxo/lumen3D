/* Contract test for the ONE dataset-type vocabulary ('3d', '2d', 'live',
   'tracking'). The type id is simultaneously the directory under DATA_WEB/, the
   first segment of a dataset id, metadata.json "type", plugin.json "dataTypes",
   the staging id and the admin filter value — so a single source has to decide
   what a type is called and what it is called IN FRONT OF THE OPERATOR.

   What is locked here:
     (a) the canonical list and its order;
     (b) the type → page routing (2d.html / tracking.html / viewer.html);
     (c) the display name: operator override (config/instance.json) first,
         translated default (lang/<code>.json types.*) second;
     (d) that resolving a display name does NOT re-enter I18n.t() — t() asks
         InstanceConfig.tokens() for {type3d}…, which asks Utils.datasetTypeLabel,
         which must read the default with I18n.raw(). A t() there is an infinite
         recursion on the FIRST translated string of every page;
     (e) locale parity for the types.* namespace across all four locale files;
     (f) that no shipped plugin still declares a retired type id.

   The three singletons are classic scripts sharing one global lexical scope in
   the browser; node's vm contexts behave the same, so they are evaluated into
   one context in page order (utils → instance-config → i18n).

   Run: node tests/js/test_dataset_types.mjs */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const LOCALES = ['en', 'fr', 'es', 'nl'];
const TYPES = ['3d', '2d', 'live', 'tracking'];

const langDoc = code => JSON.parse(readFileSync(path.join(ROOT, 'lang', `${code}.json`), 'utf8'));
const EN = langDoc('en');

/**
 * Boot Utils + InstanceConfig + I18n in one context, with config/instance.json
 * and lang/*.json served from disk (instance.json replaced by `instance`).
 * @param {object} instance   the config/instance.json body this run should see
 * @param {object} extraKeys  extra keys merged into each locale dictionary
 */
async function boot(instance = {}, extraKeys = {}) {
  const el = { setAttribute() {}, getAttribute() { return null; }, textContent: '' };
  const document = {
    documentElement: el,
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { ...el, style: {}, classList: { add() {}, remove() {} } }; },
    head: { appendChild() {} },
    body: { appendChild() {} },
  };
  const store = {};
  const ctx = {
    console,
    document,
    navigator: { language: 'en-US' },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    setTimeout, clearTimeout, queueMicrotask,
    JSON, Math, Object, Array, String, Number, Boolean, Date, Promise, Map, Set,
    Error, TypeError, RangeError, RegExp, URL, URLSearchParams, Intl,
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith('config/instance.json')) {
        return { ok: true, status: 200, json: async () => instance };
      }
      const lang = u.match(/lang\/([a-z]{2,3})\.json$/);
      if (lang) {
        const doc = langDoc(lang[1]);
        return { ok: true, status: 200, json: async () => ({ ...doc, ...extraKeys }) };
      }
      if (u.includes('lang/manifest.json')) {
        return { ok: true, status: 200, json: async () => ({ languages: LOCALES }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };   // /api/languages*
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Page order (CLAUDE.md §2.3): InstanceConfig must be loaded before I18n.init().
  for (const rel of ['js/core/utils.js', 'js/core/instance-config.js', 'js/core/i18n.js']) {
    vm.runInContext(readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
  }
  await vm.runInContext('InstanceConfig.load()', ctx);
  await vm.runInContext('I18n.init()', ctx);
  return ctx;
}

let checks = 0;
// The label is load-bearing: it names the contract in the failure message, which
// is otherwise just an assert line number in a file of near-identical assertions.
const ok = (label, fn) => {
  try { fn(); } catch (err) { err.message = `${label} — ${err.message}`; throw err; }
  checks++;
};

// ── (a) the canonical list ───────────────────────────────────────────────────
{
  const ctx = await boot();
  const types = vm.runInContext('JSON.stringify(Utils.DATASET_TYPES)', ctx);
  ok('canonical list', () => assert.deepEqual(JSON.parse(types), TYPES,
    "Utils.DATASET_TYPES must be exactly ['3d','2d','live','tracking']"));

  ok('volume types', () => assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(Utils.VOLUME_DATASET_TYPES)', ctx)),
    ['3d', 'live', 'tracking'], 'a 2D photograph carries no bricks'));

  ok('membership', () => {
    const isType = s => vm.runInContext(`Utils.isDatasetType(${JSON.stringify(s)})`, ctx);
    for (const t of TYPES) assert.equal(isType(t), true, t);
    // The retired spellings are not types any more: no alias, no double reading.
    for (const t of ['fixed', 'wholemount', 'FIXED', '', null]) {
      assert.equal(isType(t), false, `retired/unknown: ${t}`);
    }
  });

  ok('type of an id', () => {
    assert.equal(vm.runInContext("Utils.datasetTypeOfId('3d/Egfl7-E8-5')", ctx), '3d');
    assert.equal(vm.runInContext("Utils.datasetTypeOfId('2d/Photo_01')", ctx), '2d');
    assert.equal(vm.runInContext("Utils.datasetTypeOfId('fixed/Egfl7-E8-5')", ctx), null);
  });

  // ── (b) routing ───────────────────────────────────────────────────────────
  ok('routing', () => {
    const page = v => vm.runInContext(`Utils.datasetPage(${JSON.stringify(v)})`, ctx);
    assert.equal(page('2d'), '2d.html');
    assert.equal(page('tracking'), 'tracking.html');
    assert.equal(page('3d'), 'viewer.html');
    assert.equal(page('live'), 'viewer.html');
    assert.equal(page('nonsense'), 'viewer.html', 'an unknown type still opens something');
    // A dataset record routes exactly like its bare type.
    assert.equal(page({ type: '2d', id: '2d/Photo' }), '2d.html');
    assert.equal(vm.runInContext("Utils.datasetUrl({ type: '2d', id: '2d/Photo 1' })", ctx),
      '2d.html?id=2d%2FPhoto%201');
  });

  // The CSS class suffix is part of the same vocabulary ('.2d' is not a valid
  // selector, so the class is prefixed).
  ok('badge class', () => {
    assert.equal(vm.runInContext("Utils.datasetTypeBadgeClass('2d')", ctx), 'badge-2d');
    assert.equal(vm.runInContext("Utils.datasetTypeBadgeClass('tracking')", ctx), 'badge-tracking');
  });

  // ── (c1) default labels come from lang/<code>.json ────────────────────────
  ok('translated defaults', () => {
    for (const t of TYPES) {
      assert.equal(vm.runInContext(`Utils.datasetTypeLabel(${JSON.stringify(t)})`, ctx),
        EN.types[t].label, `label of ${t} falls back to types.${t}.label`);
      assert.equal(vm.runInContext(`Utils.datasetTypeTitle(${JSON.stringify(t)})`, ctx),
        EN.types[t].title, `title of ${t} falls back to types.${t}.title`);
    }
  });

  // Every translated string goes through the token pass, so a recursion would
  // fire here too — this is the cheap canary next to the explicit probe below.
  ok('a plain translated string resolves', () => {
    assert.equal(vm.runInContext("I18n.t('types.3d.label')", ctx), EN.types['3d'].label);
  });
}

// ── (d) no recursion when a string interpolates a type token ─────────────────
// The probe key is injected rather than shipped: t() is the function that would
// recurse, so it is called on a string carrying all four type tokens. An infinite
// t() → tokens() → datasetTypeLabel() → t() cycle blows the stack instead of
// returning, so this assertion is the guard.
{
  const ctx = await boot({}, { zzTypeTokenProbe: '{type3d}/{type2d}/{typeLive}/{typeTracking}' });
  ok('no recursion through the type tokens', () => {
    const out = vm.runInContext("I18n.t('zzTypeTokenProbe')", ctx);
    assert.equal(out, `${EN.types['3d'].label}/${EN.types['2d'].label}/`
      + `${EN.types.live.label}/${EN.types.tracking.label}`,
      'I18n.t must interpolate {type3d}… exactly once, without re-entering itself');
  });
}

// ── (c2) the operator's own names win, flat or per-locale ────────────────────
{
  const ctx = await boot({
    datasetTypes: {
      '3d': { label: 'Volumes', title: 'Imagerie 3D' },
      '2d': { label: { en: 'Photos', fr: 'Photographies' } },
    },
  });
  ok('operator override', () => {
    assert.equal(vm.runInContext("Utils.datasetTypeLabel('3d')", ctx), 'Volumes');
    assert.equal(vm.runInContext("Utils.datasetTypeTitle('3d')", ctx), 'Imagerie 3D');
    assert.equal(vm.runInContext("Utils.datasetTypeLabel('2d')", ctx), 'Photos',
      'a per-locale label resolves for the current locale, never "[object Object]"');
    // An entry the operator left alone still falls back to the translation.
    assert.equal(vm.runInContext("Utils.datasetTypeLabel('live')", ctx), EN.types.live.label);
    // …and a customized label reaches every translated string through the token.
    assert.equal(vm.runInContext("InstanceConfig.tokens().type3d", ctx), 'Volumes');
  });
}

// ── (e) locale parity for the types.* namespace ──────────────────────────────
ok('locale parity', () => {
  for (const code of LOCALES) {
    const doc = langDoc(code);
    assert.ok(doc.types && typeof doc.types === 'object', `lang/${code}.json has a types namespace`);
    assert.deepEqual(Object.keys(doc.types).sort(), [...TYPES].sort(),
      `lang/${code}.json types.* covers exactly the four types`);
    for (const t of TYPES) {
      for (const field of ['label', 'title', 'desc']) {
        const v = doc.types[t][field];
        assert.ok(typeof v === 'string' && v.trim(), `lang/${code}.json types.${t}.${field}`);
      }
    }
  }
});

// ── (f) no shipped plugin declares a retired type id ─────────────────────────
ok('plugin manifests', () => {
  const base = path.join(ROOT, 'js', 'modules');
  const manifests = [];
  for (const placement of readdirSync(base, { withFileTypes: true })) {
    if (!placement.isDirectory()) continue;
    const dir = path.join(base, placement.name);
    for (const mod of readdirSync(dir, { withFileTypes: true })) {
      if (!mod.isDirectory()) continue;
      const file = path.join(dir, mod.name, 'plugin.json');
      if (existsSync(file)) manifests.push([`${placement.name}/${mod.name}`, file]);
    }
  }
  assert.ok(manifests.length > 0, 'plugin manifests found');
  for (const [id, file] of manifests) {
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    if (meta.dataTypes === undefined) continue;   // legacy volume-viewer plugin
    assert.ok(Array.isArray(meta.dataTypes), `${id}: dataTypes must be an array`);
    for (const t of meta.dataTypes) {
      assert.ok(TYPES.includes(t),
        `${id}: plugin.json declares "${t}", which is not a dataset type`);
    }
  }
});

console.log('OK  dataset-type vocabulary: %d checks', checks);
