// Icon-only buttons of the measurement rows (colour swatch, show/hide eye,
// delete bin) and of the footer-links editor must carry an accessible name:
// a screen reader otherwise announces "button, button, button", and the delete
// next to the eye removes a measurement at once.
//
// The two plugins are rendered for real (vm + stubs); the viewer's built-in twin
// of the measure rows and the admin links editor are checked on their markup.
//
// Run: node tests/js/test_measure_row_a11y.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, escapeHtml } from './harness.mjs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const LOCALES = ['en', 'fr', 'es', 'nl'];

function loadPlugin(rel) {
  let impl = null;
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', textContent: '' });
      return nodes.get(id);
    },
  };
  const ctx = vm.createContext({
    console, document,
    PluginRegistry: { implement(id, obj) { impl = obj; } },
  });
  vm.runInContext(read(rel), ctx, { filename: rel });
  assert.ok(impl, `${rel} registers itself`);
  return { impl, nodes };
}

function pluginI18n(id, locale) {
  const dict = JSON.parse(read(`js/modules/tools/${id}/lang/${locale}.json`));
  return {
    dict,
    t(key, params) {
      assert.ok(Object.prototype.hasOwnProperty.call(dict, key), `${id}/${locale} has key ${key}`);
      return String(dict[key]).replace(/\{(\w+)\}/g, (_, k) => (params && k in params ? params[k] : `{${k}}`));
    },
  };
}

// Every <button …> of a markup string, as { attrs, inner }.
function buttons(html) {
  const out = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ attrs, inner: m[2] });
  }
  return out;
}

function assertNamed(btns, where) {
  assert.ok(btns.length > 0, `${where}: buttons rendered`);
  for (const b of btns) {
    const label = b.attrs['aria-label'];
    assert.ok(label && label.trim(), `${where}: button ${JSON.stringify(b.attrs)} has an aria-label`);
    assert.equal(b.attrs.title, label, `${where}: title matches aria-label`);
    assert.ok(!/\$\{/.test(label), `${where}: aria-label is interpolated`);
    if (/<i\b/.test(b.inner)) assert.ok(/aria-hidden="true"/.test(b.inner), `${where}: decorative icon is hidden from AT`);
  }
}

// ── measure-distance plugin ────────────────────────────────────────────────────
for (const locale of LOCALES) {
  const { impl, nodes } = loadPlugin('js/modules/tools/measure-distance/index.js');
  const i18n = pluginI18n('measure-distance', locale);
  impl._ctx = {
    i18n,
    ui: { escapeHtml, createIcons() {} },
    _state: {},
  };
  impl._draft = [];
  impl._measurements = [
    { id: 'm1', label: 'A', distance: 12.5, color: '#00FFFF', visible: true },
    { id: 'm2', label: 'B', distance: 3.25, color: '#FFD700', visible: false },
  ];
  impl._render();
  const html = nodes.get('volume-measure-list').innerHTML;
  const btns = buttons(html);
  assertNamed(btns, `measure-distance/${locale}`);
  const byAction = (a, id) => btns.find((b) => b.attrs['data-volume-measure-action'] === a && b.attrs['data-measurement-id'] === id);
  assert.equal(byAction('toggle-color', 'm1').attrs['aria-label'], escapeHtml(i18n.dict.changeColor));
  assert.equal(byAction('toggle', 'm1').attrs['aria-label'], escapeHtml(i18n.dict.hideMeasure), 'a visible measure offers Hide');
  assert.equal(byAction('toggle', 'm2').attrs['aria-label'], escapeHtml(i18n.dict.showMeasure), 'a hidden measure offers Show');
  assert.equal(byAction('delete', 'm2').attrs['aria-label'], escapeHtml(i18n.dict.deleteMeasure));
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    assert.ok(/aria-label="[^"]+"/.test(m[0]), `measure-distance/${locale}: the label field is named`);
  }
}

// ── tracking-measure plugin ────────────────────────────────────────────────────
for (const locale of LOCALES) {
  const { impl } = loadPlugin('js/modules/tools/tracking-measure/index.js');
  const i18n = pluginI18n('tracking-measure', locale);
  impl._ctx = { i18n, ui: { escapeHtml, createIcons() {} } };
  const list = { innerHTML: '' };
  const status = { innerHTML: '' };
  impl._els = { list, status };
  impl._draft = [];
  impl._T = { getData: () => null };
  impl.listMeasurements = () => [
    { id: 'c1', distance: 4, mode: 'snapshot', cells: [1, 2], visible: true },
    { id: 'c2', distance: 8, mode: 'follow-cells', cells: [3, 4], visible: false },
  ];
  impl._renderPanel();
  const btns = buttons(list.innerHTML);
  assertNamed(btns, `tracking-measure/${locale}`);
  const byAction = (a, id) => btns.find((b) => b.attrs['data-tm-action'] === a && b.attrs['data-measurement-id'] === id);
  assert.equal(byAction('toggle', 'c1').attrs['aria-label'], escapeHtml(i18n.dict.hideMeasure));
  assert.equal(byAction('toggle', 'c2').attrs['aria-label'], escapeHtml(i18n.dict.showMeasure));
  assert.equal(byAction('delete', 'c1').attrs['aria-label'], escapeHtml(i18n.dict.deleteMeasure));
}

// ── plugin dictionaries keep key parity ────────────────────────────────────────
for (const id of ['measure-distance', 'tracking-measure']) {
  const keys = LOCALES.map((l) => Object.keys(JSON.parse(read(`js/modules/tools/${id}/lang/${l}.json`))).sort());
  for (let i = 1; i < keys.length; i++) assert.deepEqual(keys[i], keys[0], `${id}: ${LOCALES[i]} has the keys of en`);
}

// ── viewer.js built-in twin of the measure rows ────────────────────────────────
{
  const src = read('js/pages/viewer.js');
  const start = src.indexOf('function _renderVolumeMeasurement()');
  assert.ok(start > 0, 'viewer.js renders the measure rows');
  const body = src.slice(start, src.indexOf('\n  function ', start + 10));
  const tags = [...body.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 3, 'colour, show/hide and delete buttons');
  for (const tag of tags) {
    assert.ok(/aria-label="\$\{\w+\}"/.test(tag), `viewer.js button is named: ${tag}`);
    assert.ok(/title="\$\{\w+\}"/.test(tag), `viewer.js button has a tooltip: ${tag}`);
  }
  for (const [key, fallback] of [
    ['viewer.measureChangeColor', 'Change colour'],
    ['viewer.measureShow', 'Show measurement'],
    ['viewer.measureHide', 'Hide measurement'],
    ['viewer.measureDelete', 'Delete measurement'],
  ]) {
    assert.ok(body.includes(`_t('${key}', '${fallback}')`), `viewer.js reads ${key} with an English fallback`);
  }
}

// ── admin footer-links editor: the remove button of an added row is named too ──
{
  const src = read('js/pages/admin/tab-branding.js');
  const fnStart = src.indexOf('function _linkRowFields(');
  assert.ok(fnStart > 0, 'one shared row template');
  const fn = src.slice(fnStart, src.indexOf('\n}\n', fnStart));
  assert.ok(/<button type="button"[^>]*adm-link-del[^>]*title="\$\{removeName\}" aria-label="\$\{removeName\}"/.test(fn),
    'remove button carries title and aria-label');
  const uses = (src.match(/_linkRowFields\(/g) || []).length;
  assert.ok(uses >= 3, 'initial rows and "Add link" both use the shared template');
  assert.ok(!/<button class="adm-btn[^"]*adm-link-del"><i/.test(src), 'no unnamed remove button left');
}

console.log('OK test_measure_row_a11y');
