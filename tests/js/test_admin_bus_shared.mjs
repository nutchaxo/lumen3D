// Admin plumbing: per-tab unsaved guards, tab-scoped Ctrl+S, the brand-preserving
// title marker, the fetch wrapper that keeps the CSRF header, the password dialog
// contract, the up-front insecure-context check of the import.
//
// Run: node tests/js/test_admin_bus_shared.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './harness.mjs';

// ── minimal browser surface ────────────────────────────────────
const listeners = {};
const wrap = { style: {} };
const activePanels = new Set();
globalThis.window = { addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); }, location: { origin: 'http://h' } };
globalThis.document = {
  title: 'Admin — Acme Lab',
  getElementById: (id) => (id === 'header-unsaved-wrap' ? wrap : null),
  addEventListener: (ev, fn) => { (listeners['doc:' + ev] ||= []).push(fn); },
  querySelector: (sel) => { const m = /data-tab="([^"]+)"/.exec(sel); return m && activePanels.has(m[1]) ? {} : null; },
};

const bus = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/bus.js')).href);

// ── 1. Guards are per tab ──────────────────────────────────────
{
  let a = false, b = false, discarded = [];
  bus.registerDirtyGuard('a', () => a, () => { a = false; discarded.push('a'); });
  bus.registerDirtyGuard('b', () => b, () => { b = false; discarded.push('b'); });
  assert.equal(bus.isDirty(), false);
  a = true;
  assert.equal(bus.isDirty('a'), true);
  assert.equal(bus.isDirty('b'), false, 'tab b is clean even though tab a is not');
  assert.equal(bus.isDirty(), true, 'any dirty tab is "dirty"');
  b = true;
  bus.discardDirty('a');
  assert.deepEqual(discarded, ['a'], 'discarding a tab leaves the others alone');
  assert.equal(bus.isDirty('b'), true);
  bus.discardDirty();
  assert.deepEqual(discarded, ['a', 'b']);
  assert.equal(bus.isDirty(), false);
  assert.equal(bus.isDirty('nope'), false, 'an unknown tab is clean');
  assert.ok((listeners.beforeunload || []).length === 1, 'one beforeunload guard for all tabs');
  a = true;
  let prevented = false; const ev = { preventDefault() { prevented = true; }, returnValue: undefined };
  listeners.beforeunload[0](ev);
  assert.equal(prevented, true, 'closing the page with any unsaved tab asks first');
  a = false;
}

// ── 2. The indicator is the union; the title keeps the brand ───
{
  bus.setUnsaved(true, 'x');
  assert.equal(wrap.style.display, 'inline-flex');
  assert.equal(document.title, '● Admin — Acme Lab', 'the operator\'s brand stays in the title');
  bus.setUnsaved(true, 'y');
  bus.setUnsaved(false, 'x');
  assert.equal(wrap.style.display, 'inline-flex', 'tab y is still dirty: the indicator stays');
  bus.setUnsaved(false, 'y');
  assert.equal(wrap.style.display, 'none');
  assert.equal(document.title, 'Admin — Acme Lab');
}

// ── 3. Ctrl+S only reaches the visible tab ─────────────────────
{
  const hits = [];
  bus.bindTabSave('one', () => { hits.push('one'); return true; });
  bus.bindTabSave('two', () => { hits.push('two'); return true; });
  const press = (over) => {
    let prevented = false;
    (listeners['doc:keydown'] || []).forEach((f) => f({ ctrlKey: true, key: 's', preventDefault() { prevented = true; }, ...over }));
    return prevented;
  };
  assert.equal(press({}), false, 'no tab visible: the browser keeps Ctrl+S');
  activePanels.add('two');
  assert.equal(press({}), true);
  assert.deepEqual(hits, ['two'], 'only the visible tab saves');
  assert.equal(press({ ctrlKey: false, metaKey: true }), true, 'Cmd+S works on macOS');
  assert.equal(press({ shiftKey: true }), false, 'Ctrl+Shift+S is not a save');
  activePanels.clear();
}

// ── 4. dataset opener is parked until the Datasets tab registers it ─
{
  const nav = []; bus.setNavigator((t) => nav.push(t));
  bus.openDataset('staging:3d/x');
  assert.deepEqual(nav, ['datasets']);
  const opened = [];
  bus.setDatasetOpener((id) => opened.push(id));
  assert.deepEqual(opened, ['staging:3d/x'], 'the request made before the tab existed is delivered on registration');
  bus.openDataset('staging:3d/y');
  assert.deepEqual(opened, ['staging:3d/x', 'staging:3d/y']);
}

// ── 5. apiFetch keeps the CSRF header when a caller passes headers ─
{
  const shared = await import(pathToFileURL(path.join(ROOT, 'js/pages/admin/shared.js')).href);
  let seen;
  globalThis.fetch = async (url, init) => { seen = init; return { status: 200, ok: true, text: async () => '{"ok":true}' }; };
  shared.setCsrf('tok123');
  await shared.apiFetch('api/x', { method: 'POST', headers: { 'X-Extra': '1' }, body: '{}' });
  assert.equal(seen.headers['X-CSRF-Token'], 'tok123', 'CSRF survives a caller-supplied headers object');
  assert.equal(seen.headers['X-Extra'], '1');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  assert.equal(seen.method, 'POST');
  await shared.apiFetchStatus('api/x', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(seen.headers['X-CSRF-Token'], 'tok123');
  assert.equal(seen.headers['Content-Type'], 'text/plain', 'a caller may override the content type');

  // storage helpers never throw
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(shared.storageGet('k'), null);
  assert.equal(shared.storageSet('k', 'v'), false);
  assert.equal(shared.MIN_PASSWORD, 8);
}

// ── 6. Source-level contracts ──────────────────────────────────
{
  const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
  for (const f of ['tab-marketplace.js', 'plugin-update.js', 'tab-plugins.js']) {
    const s = read('js/pages/admin/' + f);
    assert.ok(!/[^.\w]prompt\(/.test(s), `${f}: no window.prompt() for the admin password`);
    assert.ok(s.includes('askPassword('), `${f}: uses the masked dialog`);
  }
  assert.match(read('js/pages/admin/shared.js'), /type="password"[^>]*autocomplete="current-password"/, 'the dialog field is a real password input');
  assert.ok(!/< ?4\b/.test(read('js/pages/admin/tab-security.js')), 'security tab no longer accepts 4-character passwords');
  assert.ok(!/IRIBHM/.test(read('js/pages/admin/bus.js')), 'no hard-coded brand in the title marker');
  for (const f of ['tab-branding.js', 'tab-appearance.js', 'tab-legal.js', 'tab-dataset-types.js', 'tab-pages.js', 'tab-datasets.js']) {
    assert.match(read('js/pages/admin/' + f), /registerDirtyGuard\('/, `${f} registers its own unsaved guard`);
  }
  assert.ok(!/localStorage\./.test(read('js/pages/admin/shell.js')), 'the shell never touches localStorage unguarded');

  // lazy tabs: the entry imports nothing but the shell eagerly
  const entry = read('js/pages/admpan.js');
  const staticImports = entry.match(/^import .* from '\.\/admin\/[^']+';/gm) || [];
  assert.equal(staticImports.length, 1, 'admpan.js statically imports only the shell');
  assert.equal((entry.match(/registerTab\(/g) || []).length, 15, 'all fifteen tabs are still registered');
  // Cache busting: the release build stamps ?v= on STATIC specifiers only, so every
  // lazily imported tab (and the page-system scripts) must carry the entry's own stamp.
  const dyn = entry.match(/import\(`[^`]*`\)/g) || [];
  assert.equal(dyn.length, 15, 'one lazy import per tab');
  for (const d of dyn) assert.ok(d.endsWith('${V}`)'), `${d} inherits the entry's ?v= stamp`);
  assert.match(entry, /s\.src = src \+ V;/, 'page-system scripts inherit the stamp too');
  assert.match(read('js/pages/admin/upload-manager.js'), /upload-worker\.js\$\{new URL\(import\.meta\.url\)\.search\}/, 'the upload worker URL inherits the stamp');
  const shellSrc = read('js/pages/admin/shell.js');
  assert.match(shellSrc, /login-screen'\)\?\.style\.display === 'flex'\) return;/, 'a background 401 does not re-show (and refocus) an open login card');
  assert.match(shellSrc, /async function doLogout\(\)[\s\S]{0,600}discardDirty\(\);/, 'logging out drops the edits the operator agreed to discard');
  assert.match(read('js/pages/admin/tab-dataset-types.js'), /async function save\(\) \{\s*if \(!_loaded\)/, 'the Types tab never saves a form that was never loaded');
  assert.ok(!/page-renderer\.js|page-templates\.js/.test(read('admpan.html').replace(/<!--[\s\S]*?-->/g, '')), 'page-system scripts are no longer loaded eagerly');
}

console.log('admin bus + shared plumbing (per-tab guards · scoped Ctrl+S · CSRF kept · masked password · lazy tabs): OK');
