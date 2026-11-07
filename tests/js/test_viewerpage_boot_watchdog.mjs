// Boot watchdog of the viewer page (BootWatchdog, js/pages/viewer.js), lifted and run
// against a scripted DOM and fake timers:
//   • a boot that never settles ends, after the delay, on a translated "taking too long"
//     card with a Reload button, the progress body hidden;
//   • a boot that settles in time (or fails visibly) never shows it;
//   • a card shown by a slow boot steps aside when the boot finally gets through;
//   • with no I18n at all (the script that failed may be i18n.js) the English text is used;
//   • an embedded panel tells its host (PANEL_ERROR) once, to its own origin;
//   • Utils.formatNumber / formatFileSize: English output unchanged, French decimals and Mo/Go.
//
// Run: node tests/js/test_viewerpage_boot_watchdog.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, loadModule } from './harness.mjs';

const src = readFileSync(path.join(ROOT, 'js/pages/viewer.js'), 'utf8').replace(/\r\n/g, '\n');
const m = src.match(/\nconst BootWatchdog = \(\(\) => \{\n[\s\S]*?\n\}\)\(\);\n/);
assert.ok(m, 'BootWatchdog must be defined at the top of viewer.js');

function makeEnv({ i18n, embedded = false } = {}) {
  const timers = [];
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.textContent = ''; this.id = ''; this.className = '';
      const set = new Set(); this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }; }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...c) { this.children = c; }
    addEventListener(t, fn) { this.listeners[t] = fn; }
  }
  const byId = {
    'viewer-loader': new El('div'),
    'loader-body': new El('div'),
    'loader-error': new El('div')
  };
  byId['loader-error'].classList.add('hidden');
  const posted = [];
  const reloads = [];
  const ctx = vm.createContext({
    document: { getElementById: (id) => byId[id] || null, createElement: (t) => new El(t) },
    window: {
      parent: embedded ? { postMessage: (msg, origin) => posted.push({ msg, origin }) } : null,
      location: { origin: 'http://localhost:8080', reload: () => reloads.push(1) }
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    I18n: i18n
  });
  if (!embedded) ctx.window.parent = ctx.window;
  vm.runInContext(`${m[0]}; globalThis.W = BootWatchdog;`, ctx);
  const fire = () => timers.forEach((t) => { const fn = t.fn; t.fn = null; if (fn) fn(); });
  return { W: ctx.W, byId, timers, fire, posted, reloads };
}

const frI18n = { t: (k) => ({ 'viewer.bootSlowTitle': 'Trop long', 'viewer.bootSlow': 'Corps FR', 'viewer.bootReload': 'Recharger' }[k] || k) };

// 1. Never settles → the card.
{
  const e = makeEnv({ i18n: frI18n });
  e.W.arm();
  assert.equal(e.timers.length, 1);
  assert.equal(e.timers[0].ms, 20000, '20 s');
  assert.ok(!e.byId['loader-body'].classList.contains('hidden'));
  e.fire();
  const card = e.byId['loader-error'];
  assert.ok(!card.classList.contains('hidden'), 'the card is shown');
  assert.ok(e.byId['loader-body'].classList.contains('hidden'), 'the spinner steps aside');
  assert.equal(card.children[0].textContent, 'Trop long');
  assert.equal(card.children[1].textContent, 'Corps FR');
  assert.equal(card.children[2].textContent, 'Recharger');
  card.children[2].listeners.click();
  assert.equal(e.reloads.length, 1, 'the button reloads the page');
}

// 2. Settled in time → nothing.
{
  const e = makeEnv({ i18n: frI18n });
  e.W.arm();
  e.W.settle();
  e.fire();
  assert.ok(e.byId['loader-error'].classList.contains('hidden'));
  assert.ok(!e.byId['loader-body'].classList.contains('hidden'));
}

// 3. A late boot takes the card down again.
{
  const e = makeEnv({ i18n: frI18n });
  e.W.arm();
  e.fire();
  e.W.settle();
  assert.ok(e.byId['loader-error'].classList.contains('hidden'));
  assert.ok(!e.byId['loader-body'].classList.contains('hidden'), 'the progress is back');
}

// 4. No I18n at all → English; a throwing I18n too.
{
  let e = makeEnv({ i18n: undefined });
  e.W.show();
  assert.equal(e.byId['loader-error'].children[0].textContent, 'This page is taking too long to load');
  assert.equal(e.byId['loader-error'].children[2].textContent, 'Reload');
  e = makeEnv({ i18n: { t: () => { throw new Error('boom'); } } });
  e.W.show();
  assert.equal(e.byId['loader-error'].children[2].textContent, 'Reload');
}

// 5. Embedded: the host hears of it once, on this origin.
{
  const e = makeEnv({ i18n: undefined, embedded: true });
  e.W.show();
  e.W.show();
  assert.equal(e.posted.length, 1);
  assert.equal(e.posted[0].msg.type, 'PANEL_ERROR');
  assert.equal(e.posted[0].origin, 'http://localhost:8080');
}

// 6. Locale-aware numbers and byte units.
{
  const make = (lang) => loadModule('js/core/utils.js', 'Utils', { I18n: { getLanguage: () => lang } });
  const en = make('en');
  assert.equal(en.formatNumber(0.5, 2), '0.50');
  assert.equal(en.formatFileSize(1536), '1.5 KB');
  assert.equal(en.formatFileSize(0), '0 B');
  assert.deepEqual([...en.byteUnits()], ['B', 'KB', 'MB', 'GB', 'TB']);
  const fr = make('fr');
  assert.equal(fr.formatNumber(0.5, 2), '0,50');
  assert.equal(fr.formatFileSize(1536), '1,5 Ko');
  assert.equal(fr.formatFileSize(5 * 1048576), '5,0 Mo');
  assert.equal(fr.formatFileSize(0), '0 o');
  assert.equal(fr.formatNumber(NaN, 1), '—');
  assert.equal(make('es').formatFileSize(1536), '1,5 KB', 'Spanish keeps KB with a decimal comma');
}

console.log('viewer boot watchdog + locale numbers: OK');
