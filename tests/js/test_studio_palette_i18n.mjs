// The Studio command palette speaks the page's language (js/components/studio-editor.js):
//   • every command label goes through the translation table, English as fallback;
//   • the filter matches the translated label, and the English name still matches;
//   • the input's placeholder and accessible name are translated on every opening;
//   • every key the palette asks for exists, non-empty, in the four platform locales.
//
// _openPalette and _renderPaletteCommands are cut out of the source and run in a vm with
// a stub DOM and a stub translation table.
//
// Run: node tests/js/test_studio_palette_i18n.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const SRC = readFileSync(path.join(ROOT, 'js/components/studio-editor.js'), 'utf8').replace(/\r\n/g, '\n');

function cutFunction(name) {
  const start = SRC.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const end = SRC.indexOf('\n  }\n', start);
  assert.ok(end > start, `${name} has no end`);
  return SRC.slice(start, end + 4);
}

const KEYS = [...cutFunction('_renderPaletteCommands').matchAll(/'((?:studio|js)\.[A-Za-z]+)'/g)].map(m => m[1]);
KEYS.push('studio.cmdPlaceholder');
assert.ok(KEYS.length >= 12, `palette keys found: ${KEYS.join(', ')}`);

function makeEl() {
  const attrs = {};
  return {
    value: '', placeholder: '', innerHTML: '', attrs, focused: false,
    classList: { remove() {}, add() {} },
    setAttribute(name, value) { attrs[name] = value; },
    focus() { this.focused = true; },
  };
}

function realm(table) {
  const els = { 'studio-command-input': makeEl(), 'studio-command-list': makeEl() };
  const sandbox = {
    document: { getElementById: (id) => els[id] || null },
    I18n: { t: (k) => (k in table ? table[k] : k) },
    _palette: { classList: { remove() {}, add() {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    const _t = (k, def, params) => {
      const v = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(k, params) : k;
      return v === k ? def : v;
    };
    ${cutFunction('_escape')}
    ${cutFunction('_renderPaletteCommands')}
    ${cutFunction('_openPalette')}
    this.open = _openPalette;
    this.render = _renderPaletteCommands;
  `, sandbox);
  return { sandbox, els };
}

const labels = (html) => [...html.matchAll(/data-command="([^"]+)">([^<]*)</g)].map(m => [m[1], m[2]]);

const FR = {
  'studio.selectMove': 'Sélectionner / Déplacer',
  'studio.distance': 'Distance',
  'studio.angle': 'Angle',
  'studio.scalebar': 'Barre d’échelle',
  'studio.cmdFit': 'Ajuster l’image',
  'js.undo': 'Annuler',
  'js.redo': 'Refaire',
  'studio.cmdGuideX': 'Afficher / masquer le guide vertical',
  'studio.cmdGuideY': 'Afficher / masquer le guide horizontal',
  'studio.cmdExportJson': 'Exporter en JSON',
  'studio.cmdExportPng': 'Exporter en PNG',
  'studio.cmdPlaceholder': 'Tapez une commande',
};

{
  const { sandbox, els } = realm(FR);
  sandbox.open();
  const input = els['studio-command-input'];
  assert.equal(input.placeholder, 'Tapez une commande');
  assert.equal(input.attrs['aria-label'], 'Tapez une commande');
  assert.ok(input.focused, 'the input takes the focus');
  const all = labels(els['studio-command-list'].innerHTML);
  assert.equal(all.length, 11, 'empty query lists every command');
  assert.deepEqual(all.find(([id]) => id === 'undo'), ['undo', 'Annuler']);
  assert.ok(!/Undo|Export PNG/.test(els['studio-command-list'].innerHTML), 'no English label left');
  assert.ok(/type="button"/.test(els['studio-command-list'].innerHTML), 'commands are plain buttons');

  input.value = 'annuler';
  sandbox.render();
  assert.deepEqual(labels(els['studio-command-list'].innerHTML).map(([id]) => id), ['undo']);

  input.value = 'Exporter';
  sandbox.render();
  assert.deepEqual(labels(els['studio-command-list'].innerHTML).map(([id]) => id), ['export-json', 'export-png']);

  input.value = 'undo';
  sandbox.render();
  assert.deepEqual(labels(els['studio-command-list'].innerHTML).map(([id]) => id), ['undo'], 'the English name still matches');
}

{
  // No translation loaded: English fallbacks, escaped.
  const { sandbox, els } = realm({});
  sandbox.open();
  assert.equal(els['studio-command-input'].placeholder, 'Type a command');
  const all = labels(els['studio-command-list'].innerHTML);
  assert.deepEqual(all.find(([id]) => id === 'add-guide-x'), ['add-guide-x', 'Toggle vertical guide']);
}

{
  // A translated label is escaped before it reaches innerHTML.
  const { sandbox, els } = realm({ 'js.undo': '<b>x</b>' });
  sandbox.render();
  assert.ok(!els['studio-command-list'].innerHTML.includes('<b>'), 'label is escaped');
}

const lookup = (dict, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
for (const code of ['en', 'fr', 'es', 'nl']) {
  const dict = JSON.parse(readFileSync(path.join(ROOT, 'lang', `${code}.json`), 'utf8'));
  const missing = KEYS.filter(key => typeof lookup(dict, key) !== 'string' || !lookup(dict, key).trim());
  assert.deepEqual(missing, [], `lang/${code}.json lacks palette keys`);
}

console.log('ok - studio command palette is translated');
