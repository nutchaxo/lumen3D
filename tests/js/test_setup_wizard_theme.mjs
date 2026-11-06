// The first-run wizard is also the password-recovery path (the credential file
// renamed away, the wizard reappears): finishing or skipping it must not overwrite
// the operator's theme. The theme is written only when a colour is clicked, and
// then merged into the stored theme.
//
// shell.js is an ES module with DOM-bound imports; it is loaded here into a VM with
// its imports stripped, so the REAL wizard code runs against a fake site endpoint.
//
// Run: node tests/js/test_setup_wizard_theme.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './harness.mjs';

const STORED_THEME = {
  $schema: 'lumen3d-theme/1',
  tokens: { '--color-primary': '#123456', '--font-sans': 'Inter', '--radius-md': '4px' },
  dark: { '--bg-body': '#000000', '--color-primary': '#654321' },
  light: { '--bg-body': '#ffffff' },
};

function makeEl(id) {
  const listeners = {};
  const node = {
    id, value: '', textContent: '', innerHTML: '', disabled: false, dataset: {},
    style: {}, attrs: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} })); },
    setAttribute(k, v) { node.attrs[k] = String(v); },
    getAttribute(k) { return node.attrs[k] ?? null; },
    appendChild(c) { node.children.push(c); return c; },
    querySelector(sel) { return sel === '.setup-swatch' ? node.children[0] || null : null; },
    querySelectorAll(sel) { return sel === '.setup-swatch' ? node.children.slice() : []; },
    focus() {}, contains: () => false,
  };
  return node;
}

function load(themeDoc) {
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const saves = [];
  const gets = [];
  const site = 'api/site.php';
  const apiFetch = async (url) => {
    gets.push(url);
    if (url.startsWith(`${site}?action=get&doc=theme`)) return themeDoc === undefined ? null : JSON.parse(JSON.stringify(themeDoc));
    if (url.startsWith(`${site}?action=get&doc=instance`)) return { brand: { name: 'Lab' } };
    if (url.includes('marketplace_catalog')) return { plugins: [] };
    return null;
  };
  const apiFetchStatus = async (url, opts = {}) => {
    if (url.startsWith('api/auth.php?action=setup')) return { ok: true, status: 200, data: { ok: true, csrf: 'c', username: 'admin' } };
    if (url.startsWith(`${site}?action=save`)) saves.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, data: { ok: true } };
  };

  let src = readFileSync(path.join(ROOT, 'js/pages/admin/shell.js'), 'utf8')
    .replace(/^import\s[^;]*;/gm, '')
    .replace(/^export\s+(async\s+function|function|const|let|class)/gm, '$1');
  // Entering the app (tabs, topbar) is not what this test is about.
  src += `
;enterApp = function () { globalThis.__entered = true; };
globalThis.__W = {
  init: initWizard, next: wizNext, back: wizBack, skip: finishWizard,
  step: () => _wizStep,
};`;

  const sandbox = {
    console, setTimeout, clearTimeout, JSON, Math, Number, Array, Object, String, Boolean, Date, Map, Promise,
    URLSearchParams,
    location: { search: '', hash: '' },
    history: { replaceState() {} },
    window: { addEventListener() {}, requestIdleCallback: () => {} },
    document: {
      createElement: () => makeEl(''),
      querySelectorAll: () => [],
      addEventListener() {},
      body: { classList: { add() {}, remove() {} } },
      documentElement: { setAttribute() {} },
    },
    I18n: null, Utils: null,
    API_AUTH: 'api/auth.php', API_SITE: site, API_ADMIN: 'api/admin.php',
    t: (_k, d) => d ?? '',
    escHtml: (v) => String(v ?? ''),
    apiFetch, apiFetchStatus,
    setCsrf() {}, setUnauthorizedHandler() {}, toast() {}, refreshIcons() {},
    el, storageGet: () => null, storageSet() {}, MIN_PASSWORD: 8, throttleText: () => '',
    isDirty: () => false, discardDirty() {}, setNavigator() {},
    UploadDock: { setGateActive() {}, mount() {} },
    Upload: { subscribe() {}, isBusy: () => false },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'shell.js' });
  return { W: sandbox.__W, el, saves, gets, entered: () => sandbox.__entered === true };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function createAccount(env) {
  env.W.init();
  env.el('setup-username').value = 'admin';
  env.el('setup-password').value = 'correct-horse-battery';
  env.el('setup-password2').value = 'correct-horse-battery';
  await env.W.next();
  assert.equal(env.W.step(), 2, 'step 1 creates the account and moves on');
}

const swatch = (env, id) => env.el('setup-swatches').children.find((b) => b.dataset.preset === id);
const marked = (env) => env.el('setup-swatches').children.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.dataset.preset);
const themeSaves = (env) => env.saves.filter((s) => s.url.includes('doc=theme'));

// 1. Skip right after the account: the stored theme is not written.
{
  const env = load(STORED_THEME);
  await createAccount(env);
  await env.W.skip();
  assert.equal(themeSaves(env).length, 0, 'Skip sends no theme save');
  assert.equal(env.saves.filter((s) => s.url.includes('doc=instance')).length, 1, 'the identity merge still runs');
  assert.equal(env.entered(), true, 'the wizard ends in the app');
}

// 2. Click through every step without touching a swatch, then Finish.
{
  const env = load(STORED_THEME);
  await createAccount(env);
  await env.W.next(); await tick();   // step 3: theme
  assert.deepEqual(marked(env), [], 'a colour of the operator\'s own marks no preset');
  await env.W.next(); await env.W.next();   // 4, 5
  assert.equal(env.W.step(), 5);
  await env.W.next();                       // Finish
  assert.equal(themeSaves(env).length, 0, 'Finish without a swatch click sends no theme save');
}

// 3. A clicked colour is merged into the stored theme, not written over it.
{
  const env = load(STORED_THEME);
  await createAccount(env);
  await env.W.next(); await tick();
  swatch(env, 'blue').click();
  assert.deepEqual(marked(env), ['blue']);
  await env.W.skip();
  const saves = themeSaves(env);
  assert.equal(saves.length, 1, 'a picked colour is saved once');
  const body = saves[0].body;
  assert.equal(body.tokens['--color-primary'], '#2F6BFF', 'the picked colour wins');
  assert.equal(body.tokens['--font-sans'], 'Inter', 'other tokens are kept');
  assert.equal(body.tokens['--radius-md'], '4px');
  assert.equal(body.dark['--bg-body'], '#000000', 'other dark overrides are kept');
  assert.equal(body.dark['--color-primary'], undefined, 'a per-mode override of the picked token is dropped');
  assert.equal(body.light['--bg-body'], '#ffffff', 'light overrides are kept');
  assert.equal(body.$schema, 'lumen3d-theme/1');
}

// 4. Fresh install (empty theme): green, the shipped default, is shown as current,
//    but nothing is written unless it is clicked.
{
  const env = load({ $schema: 'lumen3d-theme/1', tokens: {}, dark: {}, light: {} });
  await createAccount(env);
  assert.deepEqual(marked(env), [], 'no swatch marked before the theme is known');
  await env.W.next(); await tick();
  assert.deepEqual(marked(env), ['green'], 'the default colour is marked on an empty theme');
  await env.W.skip();
  assert.equal(themeSaves(env).length, 0);
}

// 5. A stored preset colour marks that preset; an unreadable theme marks none.
{
  const env = load({ tokens: { '--color-primary': '#7c5cff' } });
  await createAccount(env);
  await env.W.next(); await tick();
  assert.deepEqual(marked(env), ['purple'], 'matching is case-insensitive');
}
{
  const env = load(undefined);
  await createAccount(env);
  await env.W.next(); await tick();
  assert.deepEqual(marked(env), [], 'no answer, no claim about the current colour');
}

// 6. Back is hidden on step 2 (the account exists, there is nothing to go back to)
//    and shown from step 3.
{
  const env = load(STORED_THEME);
  await createAccount(env);
  assert.equal(env.el('setup-back').style.display, 'none', 'Back hidden on step 2');
  env.W.back();
  assert.equal(env.W.step(), 2);
  await env.W.next(); await tick();
  assert.equal(env.el('setup-back').style.display, '', 'Back shown on step 3');
  env.W.back();
  assert.equal(env.W.step(), 2);
}

console.log('test_setup_wizard_theme: OK');
