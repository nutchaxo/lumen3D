// What a page asks the host for while it boots its plugins (js/core/plugin-trust.js,
// js/core/plugin-registry.js), measured on the real js/modules tree, vouched the way
// dev_server.py vouches it (tier + composite hash + every hashed file of the folder):
//
//   1. every plugin file is requested at <file>?v=<first 16 hex of the plugin's vouch
//      hash> with the default cache mode, so the browser keeps it (the host sends such a
//      URL immutable): a second boot of the page issues NO plugin-file request;
//   2. the `studio` placement is not fetched, verified or executed at boot — a page whose
//      Studio is never opened makes no request under js/modules/studio/ — and loads once,
//      on PluginRegistry.loadLazy('studio'), initialised exactly once;
//   3. INV-2 stays intact: bytes that came from the HTTP cache and do not hash to the vouch
//      are read once more with cache 'reload' (a stale entry cannot quarantine a good
//      plugin), a file that is really different is still refused;
//   4. never more than six plugin-file requests in flight at once, across all plugins;
//   5. StudioEditor.setModeLoader: the modes' plugins load when asked for and a failure
//      leaves the Simple view usable.
//
// Run: node tests/js/test_plugin_boot_requests.mjs
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadModule, ROOT } from './harness.mjs';

const MODULES = path.join(ROOT, 'js', 'modules');
const HASHED_EXT = ['.js', '.json', '.mjs', '.css', '.html'];   // dev_server.py _TRUST_HASH_EXT
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── the real tree, vouched like dev_server.py ──────────────────────────────────
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

const served = new Map();     // 'tools/x/index.js' -> Buffer, everything under js/modules
const plugins = [];           // discovery payload, as /api/plugins answers it
for (const placement of readdirSync(MODULES).filter(n => statSync(path.join(MODULES, n)).isDirectory())) {
  for (const folder of readdirSync(path.join(MODULES, placement)).sort()) {
    const dir = path.join(MODULES, placement, folder);
    if (!statSync(dir).isDirectory()) continue;
    let metaText;
    try { metaText = readFileSync(path.join(dir, 'plugin.json'), 'utf8'); } catch { continue; }
    const files = walk(dir);
    const hashes = {};
    for (const rel of files) {
      const bytes = readFileSync(path.join(dir, rel));
      served.set(`${placement}/${folder}/${rel}`, bytes);
      if (HASHED_EXT.includes(path.extname(rel).toLowerCase()) && !path.basename(rel).startsWith('.')) hashes[rel] = sha256(bytes);
    }
    const doc = 'lumen-plugin-trust/1\n' + Object.keys(hashes).sort().map(rel => `${rel}:${hashes[rel]}`).join('\n');
    plugins.push({
      ...JSON.parse(metaText), placement, path: `${placement}/${folder}`,
      trust: { tier: 'dev', hash: sha256(doc), mode: null, caps: null, files: Object.keys(hashes).sort() },
    });
  }
}
const byPath = new Map(plugins.map(p => [p.path, p]));
const STUDIO = plugins.filter(p => p.placement === 'studio');
assert.ok(STUDIO.length >= 1, 'the tree holds a studio plugin (advanced-studio)');
assert.ok(STUDIO.some(p => p.trust.files.length >= 40), 'the Advanced Studio is the many-file plugin this test is about');
const stampOf = (p) => p.trust.hash.slice(0, 16);

// ── a host with an HTTP cache ───────────────────────────────────────────────────
// `?v=` URLs are immutable (what dev_server.py / .htaccess answer), the others revalidate.
function makeNet() {
  const net = {
    cache: new Map(),            // url -> Buffer (the browser's HTTP cache)
    override: new Map(),         // 'tools/x/index.js' -> Buffer (what the host really serves now)
    failing: new Set(),          // 'tools/x/index.js' -> answer 500
    log: [],                     // plugin-file requests that reached the host { url, mode }
    cacheHits: 0,
    inFlight: 0,
    maxInFlight: 0,
    discoveryCalls: 0,
  };
  net.fetch = async (url, opts = {}) => {
    url = String(url);
    if (/^api\/plugins/.test(url)) {
      net.discoveryCalls++;
      return { ok: true, status: 200, json: async () => ({ plugins: JSON.parse(JSON.stringify(plugins)), trustEpoch: 1 }) };
    }
    const m = /^js\/modules\/(.+?)(\?v=([0-9a-f]+))?$/.exec(url);
    if (!m) return { ok: false, status: 404 };
    const mode = opts.cache || 'default';
    const immutable = Boolean(m[2]);
    const respond = (buf) => ({
      ok: true, status: 200,
      arrayBuffer: async () => Uint8Array.from(buf).buffer,
      json: async () => JSON.parse(buf.toString('utf8')),
    });
    if (mode === 'default' && immutable && net.cache.has(url)) {
      net.cacheHits++;
      return respond(net.cache.get(url));
    }
    net.log.push({ url, mode });
    net.inFlight++;
    net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
    await new Promise(resolve => setImmediate(resolve));   // a request takes time: others overlap
    net.inFlight--;
    if (net.failing.has(m[1])) return { ok: false, status: 500 };
    const body = net.override.get(m[1]) || served.get(m[1]);
    if (!body) return { ok: false, status: 404 };
    net.cache.set(url, body);
    return respond(body);
  };
  return net;
}

// ── a page: PluginTrust + PluginRegistry over that host ────────────────────────
function makePage(net) {
  const blobs = new Map();
  let blobSeq = 0;
  const inits = [];
  const executed = [];
  const warnings = [];
  const sandboxBase = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, fetch: net.fetch };
  const PT = loadModule('js/core/plugin-trust.js', 'PluginTrust', sandboxBase);
  let PR = null;
  const document = {
    currentScript: { nonce: 'N' },
    createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {}, onload: null, onerror: null }),
    createTextNode: (text) => ({ text }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild: (el) => el },
    body: {
      appendChild: (el) => {
        const code = new TextDecoder().decode(blobs.get(el.src) || new Uint8Array());
        const id = /PluginRegistry\.implement\(\s*['"]([^'"]+)['"]/.exec(code)?.[1];
        queueMicrotask(() => {
          if (id) {
            executed.push(id);
            PR.implement(id, { init() { inits.push(id); }, activate() {}, deactivate() {} });
          }
          el.onload && el.onload();
        });
      },
    },
  };
  PR = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
    ...sandboxBase,
    document, window: {},
    console: { ...console, warn: (...a) => warnings.push(a.join(' ')), debug() {}, info() {} },
    I18n: { t: k => k, translateDOM() {}, forPlugin: () => ({ t: k => k }), registerPluginLang() {}, loadPluginLang: async () => {} },
    queueMicrotask,
    Blob: class { constructor(parts) { this._bytes = parts[0]; } },
    URL: { createObjectURL: (b) => { const u = `blob:t/${++blobSeq}`; blobs.set(u, b._bytes); return u; }, revokeObjectURL() {} },
    PluginTrust: PT,
  });
  return { PT, PR, inits, executed, warnings };
}

const VIEWER = { dataType: '3d', allowUndeclaredDataTypes: true, context: 'page' };
const ctx = { ui: {}, studio: {} };

async function boot(page, opts) {
  const paths = await page.PR.discover('js/modules');
  await page.PR.loadModules('js/modules', paths, opts);
  await page.PR.initAll(ctx);
  return paths;
}

const filesUnder = (net, needle) => net.log.filter(r => r.url.includes(needle));

// ── 0. what the page loads, with and without the deferral ─────────────────────
const eagerNet = makeNet();
const eagerPage = makePage(eagerNet);
await boot(eagerPage, VIEWER);
const eagerLoaded = eagerPage.PR.listByPlacement('studio').length;
const eagerRequests = eagerNet.log.length;
assert.equal(eagerLoaded, 1, 'without the deferral the Studio plugin is loaded at boot (the behaviour of v1.87.0)');
assert.ok(filesUnder(eagerNet, '/studio/').length >= 40, 'and its files are all requested');

// ── 1. cold boot of the viewer: nothing under studio/, every URL stamped ──────
const net = makeNet();
const page = makePage(net);
const paths = await boot(page, { ...VIEWER, deferPlacements: ['studio'] });
assert.ok(paths.includes('studio/advanced-studio'), 'discovery still lists the studio plugin');
assert.equal(filesUnder(net, '/studio/').length, 0, 'cold boot: ZERO requests under js/modules/studio/');
assert.equal(net.cacheHits, 0);
assert.equal(page.PR.listByPlacement('studio').length, 0, 'the studio plugin is not registered');
assert.ok(!page.executed.includes('advanced-studio'), 'its index.js did not run');
assert.equal(page.PR.hasDeferred('studio'), true, 'it waits for the first use');
assert.ok(page.PR.listByPlacement('tools').length >= 10, 'every other placement loaded as before');
// (the sandbox example never calls implement(): the stub script runner cannot run it)
const faults = (PR) => PR.getQuarantined().filter(q => q.path !== 'tools/screenshot-sandboxed');
assert.equal(faults(page.PR).length, 0, `nothing quarantined: ${JSON.stringify(faults(page.PR))}`);
const coldRequests = net.log.length;
assert.equal(coldRequests, eagerRequests - STUDIO.reduce((n, p) => n + p.trust.files.length, 0),
  'the saving of the deferral is exactly the studio plugin files');

// every plugin file URL carries ?v=<16 hex of ITS plugin's vouch hash>, default cache mode
for (const { url, mode } of net.log) {
  const m = /^js\/modules\/([^/]+\/[^/]+)\/(.+)\?v=([0-9a-f]{16})$/.exec(url);
  assert.ok(m, `stamped URL: ${url}`);
  assert.equal(m[3], stampOf(byPath.get(m[1])), `the stamp is the head of the plugin's hash: ${url}`);
  assert.equal(mode, 'default', `default cache mode, not no-cache: ${url}`);
}
assert.equal(new Set(net.log.map(r => r.url)).size, coldRequests, 'each file is requested once');
// ...and no plugin.json fetch of its own: discovery carried the metadata, the hash pass the bytes.
assert.equal(net.discoveryCalls, 1);

// ── 2. warm boot: the browser kept every file ─────────────────────────────────
const warm = makePage(net);
net.log.length = 0;
const hitsBefore = net.cacheHits;
await boot(warm, { ...VIEWER, deferPlacements: ['studio'] });
assert.equal(net.log.length, 0, 'warm boot: no plugin-file request reaches the host');
assert.equal(net.cacheHits - hitsBefore, coldRequests, 'every file came from the HTTP cache');
const toolIds = (pg) => Array.from(pg.PR.listByPlacement('tools'), p => p.id).sort();
assert.deepEqual(toolIds(warm), toolIds(page), 'the same plugins load');
assert.equal(faults(warm.PR).length, 0);

// ── 3. concurrency cap, across all plugins ────────────────────────────────────
assert.ok(eagerNet.maxInFlight <= 6, `at most 6 in flight (cold, every plugin, ${eagerNet.maxInFlight})`);
assert.ok(eagerNet.maxInFlight >= 4, `the cap does not serialise the boot (${eagerNet.maxInFlight} in flight)`);
assert.equal(eagerPage.PT.MAX_IN_FLIGHT, 6);
{
  // a plugin alone with many files obeys the same cap, and a failure frees its slot
  const n = makeNet();
  const p = makePage(n);
  const vouched = STUDIO[0];
  const h = await p.PT.hashPluginFiles('js/modules', vouched.path, vouched.trust.files, { stamp: stampOf(vouched) });
  assert.ok(h && h.hash === vouched.trust.hash, 'the 49-file plugin hashes to its vouch through the limiter');
  assert.ok(n.maxInFlight <= 6, `one plugin, ${vouched.trust.files.length} files: ${n.maxInFlight} in flight`);
  n.failing.add(`${vouched.path}/${vouched.trust.files[3]}`);
  n.cache.clear();
  assert.equal(await p.PT.hashPluginFiles('js/modules', vouched.path, vouched.trust.files, { stamp: stampOf(vouched) }), null, 'a failed file is a failed fetch');
  n.failing.clear();
  n.log.length = 0;
  const again = await p.PT.hashPluginFiles('js/modules', vouched.path, vouched.trust.files, { stamp: stampOf(vouched) });
  assert.ok(again && again.hash === vouched.trust.hash, 'the slots of a failed run were released: the next run completes');
}

// ── 4. lazy studio: loaded on first use, once, initialised once ───────────────
{
  const n = net;
  n.log.length = 0;
  assert.equal(page.inits.includes('advanced-studio'), false);
  const first = page.PR.loadLazy('studio', ctx);
  const second = page.PR.loadLazy('studio', ctx);
  assert.equal(first, second, 'every caller shares one promise');
  assert.equal(page.PR.hasDeferred('studio'), false, 'nothing waits once the load runs');
  const result = await first;
  assert.deepEqual(Array.from(result.ids), ['advanced-studio']);
  const files = filesUnder(n, '/studio/advanced-studio/');
  assert.equal(files.length, STUDIO[0].trust.files.length, 'the plugin\'s files are requested now');
  for (const { url } of files) assert.ok(url.endsWith(`?v=${stampOf(STUDIO[0])}`), url);
  assert.ok(n.maxInFlight <= 6);
  assert.equal(page.executed.filter(id => id === 'advanced-studio').length, 1);
  assert.deepEqual(page.inits.filter(id => id === 'advanced-studio'), ['advanced-studio'], 'init() ran once');
  assert.equal(page.PR.listByPlacement('studio').length, 1);
  assert.equal(page.PR.getModule('advanced-studio').meta._trust.tier, 'dev', 'verified like any other plugin');
  await page.PR.loadLazy('studio', ctx);
  await page.PR.initAll(ctx);
  assert.deepEqual(page.inits.filter(id => id === 'advanced-studio'), ['advanced-studio'], 'neither a second loadLazy nor a later initAll initialises it again');
  assert.equal(filesUnder(n, '/studio/advanced-studio/').length, files.length, 'no further request');
  assert.equal((await page.PR.loadLazy('tools', ctx)).ids.length, 0, 'a placement nothing was deferred for is a no-op');
}

// the warm boot has the studio files in cache too: opening the Studio there is request-free
{
  net.log.length = 0;
  await warm.PR.loadLazy('studio', ctx);
  assert.equal(net.log.length, 0, 'a warm Studio opens without one request');
  assert.deepEqual(warm.inits.filter(id => id === 'advanced-studio'), ['advanced-studio']);
}

// a placement gated out by the page (data type / context) is never announced as waiting
{
  const n = makeNet();
  const p = makePage(n);
  await boot(p, { ...VIEWER, dataType: '2d', deferPlacements: ['studio'] });
  assert.equal(p.PR.hasDeferred('studio'), false, 'advanced-studio does not declare 2d: nothing to load');
  const q = makePage(n);
  await boot(q, { ...VIEWER, context: 'panel', deferPlacements: ['studio'] });
  assert.equal(q.PR.hasDeferred('studio'), false, 'an embedded page does not take a page-only plugin');
  assert.equal(n.log.filter(r => r.url.includes('/studio/')).length, 0);
}

// a load that fails leaves the registry usable and the next call tries again
{
  const n = makeNet();
  const p = makePage(n);
  await boot(p, { ...VIEWER, deferPlacements: ['studio'] });
  n.failing.add('studio/advanced-studio/ij-core.js');
  // a request that does not get through (a dropped connection, a 429) must reach the
  // caller, or the Studio would never report it and never ask again
  await assert.rejects(p.PR.loadLazy('studio', ctx), (err) => {
    assert.equal(err.code, 'PLUGIN_LOAD_FAILED');
    assert.equal(err.failed.length, 1);
    assert.equal(err.failed[0].path, 'studio/advanced-studio');
    return true;
  }, 'a plugin whose files cannot be fetched rejects the lazy load');
  assert.equal(p.PR.listByPlacement('studio').length, 0, 'not registered');
  assert.equal(p.PR.getQuarantined().some(q => q.path === 'studio/advanced-studio'), false,
    'a transient failure is not left in the quarantine ledger');
  assert.equal(p.PR.hasDeferred('studio'), true, 'the Studio plugin still waits: the next open retries');
  assert.equal(p.PR.listByPlacement('tools').length > 0, true, 'the rest of the page is untouched');
  n.failing.clear();
  n.cache.clear();
  const retried = await p.PR.loadLazy('studio', ctx);
  assert.deepEqual(Array.from(retried.ids), ['advanced-studio'], 'the retry loads it');
  assert.equal(p.PR.hasDeferred('studio'), false);
  assert.deepEqual(p.inits.filter(id => id === 'advanced-studio'), ['advanced-studio'], 'initialised once');
}
// a refusal that is not about the network is reported once and not retried forever
{
  const n = makeNet();
  const p = makePage(n);
  await boot(p, { ...VIEWER, deferPlacements: ['studio'] });
  n.override.set('studio/advanced-studio/ij-core.js', Buffer.from('/* tampered */'));
  await assert.rejects(p.PR.loadLazy('studio', ctx), (err) => err.code === 'PLUGIN_LOAD_FAILED');
  assert.ok(p.PR.getQuarantined().some(q => q.path === 'studio/advanced-studio' && q.reason === 'untrusted'),
    'a hash mismatch stays quarantined for the admin');
  assert.equal(p.PR.hasDeferred('studio'), false, 'and is not retried');
  assert.deepEqual(Array.from((await p.PR.loadLazy('studio', ctx)).ids), [], 'a later call is a no-op');
}

// ── 5. INV-2 with a cache in the way ──────────────────────────────────────────
const TARGET = byPath.get('tools/toggle-grid');
const targetFiles = TARGET.trust.files;
const targetUrl = (rel) => `js/modules/${TARGET.path}/${rel}?v=${stampOf(TARGET)}`;
{
  // (d1) a stale body in the HTTP cache: one retry that bypasses it, then accepted
  const n = makeNet();
  const p = makePage(n);
  n.cache.set(targetUrl('index.js'), Buffer.from('/* an older version of the plugin */'));
  const verdict = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), TARGET.trust, 'js/modules', TARGET.path, null);
  assert.equal(verdict.tier, 'dev', `a stale cache entry does not quarantine a good plugin (${verdict.reason})`);
  assert.equal(verdict.hash, TARGET.trust.hash);
  assert.equal(Buffer.from(verdict.bytes).toString(), served.get(`${TARGET.path}/index.js`).toString(), 'the bytes handed to execution are the verified ones');
  const reloads = n.log.filter(r => r.mode === 'reload');
  assert.equal(reloads.length, targetFiles.length, 'one retry, every file read past the cache');
  assert.equal(n.log.filter(r => r.mode === 'default').length, targetFiles.length - 1, 'the first pass read the rest');
  // the cache repaired itself: the next boot is free
  n.log.length = 0;
  const again = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), TARGET.trust, 'js/modules', TARGET.path, null);
  assert.equal(again.tier, 'dev');
  assert.equal(n.log.length, 0, 'the reload refreshed the cached entry');
}
{
  // (d2) bytes that really differ from the vouch: still refused, after exactly one retry
  const n = makeNet();
  const p = makePage(n);
  n.override.set(`${TARGET.path}/index.js`, Buffer.from('/* tampered */ document.title = "owned";'));
  const verdict = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), TARGET.trust, 'js/modules', TARGET.path, null);
  assert.equal(verdict.tier, 'untrusted', 'a genuinely different file is refused');
  assert.match(verdict.reason, /hash mismatch/);
  assert.equal(n.log.filter(r => r.mode === 'reload').length, targetFiles.length, 'one retry only');
  assert.equal(n.log.length, targetFiles.length * 2);
  // through the registry: quarantined and never injected
  const q = makePage(n);
  const paths2 = await q.PR.discover('js/modules');
  await q.PR.loadModules('js/modules', paths2.filter(x => x === TARGET.path), VIEWER);
  assert.ok(q.PR.getQuarantined().some(e => e.path === TARGET.path && e.reason === 'untrusted'));
  assert.ok(!q.executed.includes('toggle-grid'), 'the tampered plugin never ran');
}
{
  // (d3) with no cache involved (an unstamped read) nothing is retried
  const n = makeNet();
  const p = makePage(n);
  const unstamped = { ...TARGET.trust, hash: 'not-a-hex-hash' };
  const verdict = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), unstamped, 'js/modules', TARGET.path, null);
  assert.equal(verdict.tier, 'untrusted');
  assert.equal(n.log.length, targetFiles.length, 'no stamp, no cache, no retry');
  assert.ok(n.log.every(r => r.mode === 'no-cache' && !r.url.includes('?v=')), 'unstamped URLs keep revalidating');
}
{
  // (d4) a static host without a server vouch: the release manifest stamps each file
  const n = makeNet();
  const p = makePage(n);
  const manifest = {};
  for (const rel of targetFiles) manifest[`js/modules/${TARGET.path}/${rel}`] = sha256(served.get(`${TARGET.path}/${rel}`));
  const verdict = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), null, 'js/modules', TARGET.path, manifest);
  assert.equal(verdict.tier, 'bundled');
  for (const { url, mode } of n.log) {
    const rel = url.slice(`js/modules/${TARGET.path}/`.length, url.indexOf('?'));
    assert.equal(url.split('?v=')[1], manifest[`js/modules/${TARGET.path}/${rel}`].slice(0, 16), `per-file manifest stamp: ${url}`);
    assert.equal(mode, 'default');
  }
  n.cache.set(`js/modules/${TARGET.path}/index.js?v=${manifest[`js/modules/${TARGET.path}/index.js`].slice(0, 16)}`, Buffer.from('stale'));
  n.log.length = 0;
  const healed = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), null, 'js/modules', TARGET.path, manifest);
  assert.equal(healed.tier, 'bundled', 'a stale cached file is re-read past the cache once');
  assert.equal(n.log.filter(r => r.mode === 'reload').length, targetFiles.length);
  n.override.set(`${TARGET.path}/index.js`, Buffer.from('/* tampered */'));
  n.cache.clear();
  const refused = await p.PT.evaluate(JSON.parse(JSON.stringify(TARGET)), null, 'js/modules', TARGET.path, manifest);
  assert.equal(refused.tier, 'untrusted');
  assert.equal(refused.reason, 'manifest mismatch');
}

// ── 6. StudioEditor.setModeLoader ─────────────────────────────────────────────
{
  const SRC = readFileSync(path.join(ROOT, 'js/components/studio-editor.js'), 'utf8').replace(/\r/g, '');
  const RETURN_RE = /\n  return \{\n    init,/;
  assert.ok(RETURN_RE.test(SRC));
  assert.ok(/_renderAll\(\);\n    _refreshModeSwitch\(\);\n    _ensureModes\(\);\n    return _docToken;/.test(SRC),
    'opening a document starts loading the modes\' plugins');
  const HOOK = `
  globalThis.__studio = {
    open(container) { _container = container; _isOpen = true; _doc = { layers: [] }; },
    ensure: () => _ensureModes(),
    refresh: () => _refreshModeSwitch(),
    get loading() { return Boolean(_modesLoading); },
  };`;
  const makeEl = () => {
    const e = { children: [], attrs: {}, dataset: {}, classes: new Set(), disabled: false, textContent: '', className: '', title: '',
      classList: { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), toggle: (c, f) => { if (f) e.classes.add(c); else e.classes.delete(c); }, contains: (c) => e.classes.has(c) },
      setAttribute(k, v) { e.attrs[k] = String(v); }, appendChild(c) { e.children.push(c); return c; }, replaceChildren() { e.children = []; },
      addEventListener() {}, querySelector: () => null, closest: () => null };
    return e;
  };
  const sw = makeEl();
  const root = makeEl();
  const toasts = [];
  const errors = [];
  const sandbox = {
    console: Object.assign(Object.create(console), { error: (...a) => errors.push(a.join(' ')), warn() {} }),
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
    ExportManager: { toast: (t) => toasts.push(t) },
    I18n: { t: (k) => ({ 'studio.modeLoading': 'Loading…', 'studio.modeSimple': 'Simple' }[k] ?? k), translateDOM() {} },
    document: { getElementById: (id) => ({ 'studio-mode-switch': sw, 'studio-mode-root': root }[id] || null), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => makeEl(), body: { appendChild() {} } },
    window: { innerWidth: 800, innerHeight: 600, addEventListener() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC.replace(RETURN_RE, (m) => `\n${HOOK}${m}`), sandbox, { filename: 'studio-editor.js' });
  const S = sandbox.__studio;
  const E = vm.runInContext('StudioEditor', sandbox);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const labels = () => sw.children.map(b => b.children.at(-1)?.textContent);

  // no loader: nothing changes
  S.open(makeEl());
  S.ensure(); S.refresh();
  assert.ok(sw.classes.has('hidden'), 'no mode, no loader: no switch');

  // a loader with nothing pending is not called
  let pending = true;
  let release = null;
  let loadCalls = 0;
  E.setModeLoader({
    pending: () => pending,
    load: () => { loadCalls++; pending = false; return new Promise((resolve) => { release = resolve; }); },
  });
  S.ensure();
  assert.equal(loadCalls, 1, 'the load starts when the Studio needs the modes');
  assert.equal(S.loading, true);
  assert.ok(!sw.classes.has('hidden'), 'the switch shows while the modes load');
  assert.deepEqual(labels(), ['Simple', 'Loading…'], 'a Simple button and a loading placeholder');
  assert.equal(sw.children[1].disabled, true);
  S.ensure();
  assert.equal(loadCalls, 1, 'one load at a time');
  // asking for a mode that is not registered yet waits for the load, then registers
  const entering = E.setMode('advanced');
  E.registerMode({ id: 'advanced', label: () => 'Advanced', mount() {}, unmount() {} });
  release();
  assert.equal(await entering, true, 'setMode of a plugin\'s mode loads the plugin first');
  assert.equal(S.loading, false);
  assert.deepEqual(labels(), ['Simple', 'Advanced'], 'the placeholder gives way to the mode');
  await E.setMode('simple');

  // a failing load: Simple stays usable, translated toast, console.error, retry possible
  const failed = makeEl();
  sandbox.document.getElementById = (id) => ({ 'studio-mode-switch': failed, 'studio-mode-root': root }[id] || null);
  let attempts = 0;
  pending = true;
  E.setModeLoader({ pending: () => pending, load: async () => { attempts++; throw new Error('secret internal detail'); } });
  S.ensure();
  await flush(); await flush();
  assert.equal(attempts, 1);
  assert.equal(S.loading, false);
  assert.equal(toasts.length, 1, 'one toast');
  assert.ok(!toasts.join(' ').includes('secret internal detail'), 'never the error message in the DOM');
  assert.equal(toasts[0], 'The other Studio views could not be loaded.', 'the translated sentence (English default here)');
  assert.ok(errors.some(e => e.includes('could not be loaded')), 'the cause goes to the console');
  S.ensure();
  await flush(); await flush();
  assert.equal(attempts, 2, 'the next attempt tries again');
  E.setModeLoader(null);
  S.ensure();
  assert.equal(attempts, 2, 'no loader: nothing to call');
}

// ── 7. the pages hand the Studio its loader and defer the placement ───────────
for (const f of ['js/pages/viewer.js', 'js/pages/2d.js', 'js/pages/compare.js']) {
  const src = readFileSync(path.join(ROOT, f), 'utf8');
  assert.ok(/deferPlacements: \['studio'\]/.test(src), `${f} defers the studio placement`);
  assert.ok(/StudioEditor\.setModeLoader\(\{[\s\S]*?hasDeferred\('studio'\)[\s\S]*?loadLazy\('studio'/.test(src), `${f} registers the Studio's loader`);
}

// ── numbers ───────────────────────────────────────────────────────────────────
const allFiles = plugins.reduce((n, p) => n + p.trust.files.length, 0);
console.log(`plugins in the tree: ${plugins.length}, files vouched: ${allFiles} (studio: ${STUDIO.reduce((n, p) => n + p.trust.files.length, 0)})`);
console.log(`viewer boot, plugin-file requests: v1.87.0 ${eagerRequests} (every boot) -> cold ${coldRequests}, warm 0 (max ${eagerNet.maxInFlight} in flight)`);
console.log('plugin boot requests: OK');
