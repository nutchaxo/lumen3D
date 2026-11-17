// The `studio` plugin placement (js/core/plugin-registry.js):
//   - a studio plugin loads, is listed by placement, and no toolbar builder sees it
//   - plugin.json `scripts` / `styles`: path validation (quarantine on a bad entry)
//   - ctx.plugin.execScripts() runs the styles then the scripts IN ORDER, from the
//     bytes the trust pass already fetched (no further fetch), once
//   - ctx.plugin.fileUrl / assetUrl
//   - a sandboxed verdict on a studio plugin is quarantined (in-page trust only)
//   - the plugin lists of the admin / servers carry the placement (static checks)
//
// Run: node tests/js/test_plugin_studio_placement.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const enc = new TextEncoder();

// ── minimal DOM: records scripts / styles, "executes" blob scripts on append ──
const blobs = new Map();            // blob url -> Uint8Array
let blobSeq = 0;
const executed = [];                // file labels, in execution order
const heads = [];                   // <style> elements appended to head
const scriptsAppended = [];

class El {
  constructor(tag) { this.tagName = tag; this._a = {}; this.children = []; this.dataset = {}; this.onload = null; this.onerror = null; }
  setAttribute(k, v) { this._a[k] = String(v); }
  getAttribute(k) { return k in this._a ? this._a[k] : null; }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.children = [{ text: String(v) }]; }
  get text() { return this.children.map(c => c.text || '').join(''); }
}
const document = {
  currentScript: { nonce: 'NONCE123' },
  createElement: t => new El(t),
  createTextNode: text => ({ text }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  head: { appendChild: el => { heads.push(el); return el; } },
  body: {
    appendChild: el => {
      scriptsAppended.push(el);
      const bytes = blobs.get(el.src);
      queueMicrotask(() => {
        if (!bytes) { el.onerror && el.onerror(); return; }
        const code = new TextDecoder().decode(bytes);
        if (code.includes('THROW')) { el.onerror && el.onerror(); return; }
        const m = /mark\('([^']+)'\)/.exec(code);
        if (m) executed.push(m[1]);
        el.onload && el.onload();
      });
    }
  }
};
const URLShim = {
  createObjectURL: (b) => { const u = `blob:t/${++blobSeq}`; blobs.set(u, b._bytes); return u; },
  revokeObjectURL: (u) => { URLShim.revoked.push(u); },
  revoked: []
};
class BlobShim { constructor(parts, opts) { this._bytes = parts[0]; this.type = opts && opts.type; } }

let fetches = 0;
let verdictFor = () => null;
const net = { fetch: null };           // swapped per scenario

const PR2 = loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
  document, window: {},
  I18n: { t: k => k, translateDOM() {}, forPlugin: () => ({ t: k => k }) },
  fetch: async (...a) => { fetches++; return net.fetch ? net.fetch(...a) : { ok: false, status: 404 }; },
  queueMicrotask, TextDecoder, TextEncoder, Blob: BlobShim, URL: URLShim,
  PluginTrust: { evaluate: async (meta) => verdictFor(meta) },
});

function files(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = enc.encode(v);
  return out;
}

const baseMeta = (over = {}) => ({
  id: 'adv', name: 'Adv', version: '1.0.0', placement: 'studio', ...over
});

async function load2(meta, fileMap, tier) {
  verdictFor = () => ({ tier: tier || 'approved-trusted', hash: 'h', bytes: enc.encode('/*i*/'),
    files: files({ 'index.js': '/*i*/', 'plugin.json': '{}', ...fileMap }) });
  const res = { ok: true, status: 200, json: async () => ({ plugins: [{ ...meta, path: `studio/${meta.id}` }], trustEpoch: 1 }) };
  net.fetch = async (url) => (String(url).includes('api/plugins.php') ? res : { ok: false, status: 404 });
  const paths = await PR2.discover('js/modules');
  await PR2.loadModules('js/modules', paths, { dataType: '3d', allowUndeclaredDataTypes: true });
}

function reset() { executed.length = 0; heads.length = 0; scriptsAppended.length = 0; fetches = 0; }

// ── 1. a studio plugin loads, is listed, and the toolbar ignores it ──────────
{
  reset();
  await load2(baseMeta(), {});
  const listed = PR2.listByPlacement('studio');
  assert.equal(listed.length, 1, 'studio plugin is listed by placement');
  assert.equal(listed[0].id, 'adv');
  assert.equal(PR2.getQuarantined().length, 0, 'not quarantined');
  assert.equal(PR2.listByPlacement('tools').length, 0, 'not a tools plugin');
  assert.equal(JSON.stringify(PR2.describeToolbar()), JSON.stringify({ tools: [], toggles: [] }), 'describeToolbar ignores studio');
  // buildToolbarButtons creates nothing for it (no group container would match anyway)
  const container = new El('div'); container.querySelectorAll = () => [];
  PR2.buildToolbarButtons({ groups: [{ group: 'tools', container }] });
  assert.equal(container.children.length, 0, 'toolbar builder ignores studio');
}

// ── 2. execScripts: styles first, scripts in order, verified bytes, no fetch ─
{
  reset();
  await load2(baseMeta({ scripts: ['a.js', 'sub/b.js', 'c.js'], styles: ['s.css'] }), {
    'a.js': "mark('a');", 'sub/b.js': "mark('b');", 'c.js': "mark('c');", 's.css': '.ij-x{color:red}'
  });
  assert.equal(PR2.getQuarantined().length, 0, 'valid scripts/styles are accepted');
  let ctxSeen = null;
  PR2.implement('adv', { init(ctx) { ctxSeen = ctx; } });
  await PR2.initAll({ marker: 1 });
  assert.ok(ctxSeen && ctxSeen.plugin, 'ctx.plugin exists');
  assert.equal(ctxSeen.marker, 1, 'the shared ctx is still inherited');
  assert.equal(ctxSeen.plugin.id, 'adv');
  assert.equal(ctxSeen.plugin.base, 'js/modules/studio/adv');
  const fetchesBefore = fetches;
  assert.deepEqual(executed, [], 'nothing runs before execScripts()');
  const p1 = ctxSeen.plugin.execScripts();
  const p2 = ctxSeen.plugin.execScripts();
  assert.equal(p1, p2, 'execScripts runs once (same promise)');
  await p1;
  assert.deepEqual(executed, ['a', 'b', 'c'], 'scripts run in the declared order');
  assert.equal(fetches, fetchesBefore, 'no extra fetch: the verified bytes are used');
  assert.equal(heads.length, 1, 'one <style> element');
  assert.equal(heads[0].tagName, 'style');
  assert.equal(heads[0].getAttribute('nonce'), 'NONCE123', 'style carries the page nonce');
  assert.equal(heads[0].text, '.ij-x{color:red}', 'style text = the verified bytes');
  assert.ok(scriptsAppended.every(s => s.getAttribute('nonce') === 'NONCE123'), 'scripts carry the nonce');
  assert.deepEqual([...executed], ['a', 'b', 'c']);
  assert.ok(scriptsAppended.every(s => String(s.src).startsWith('blob:')), 'scripts run from blob URLs');
  const afterFirst = scriptsAppended.length;
  await ctxSeen.plugin.execScripts();
  assert.equal(afterFirst, 4, 'index.js + the three declared scripts');
  assert.equal(scriptsAppended.length, afterFirst, 'a second call injects nothing more');

  // fileUrl / assetUrl
  const u1 = ctxSeen.plugin.fileUrl('a.js');
  assert.ok(u1.startsWith('blob:') && blobs.get(u1), 'fileUrl is a blob URL of the verified bytes');
  assert.equal(new TextDecoder().decode(blobs.get(u1)), "mark('a');");
  assert.equal(ctxSeen.plugin.fileUrl('a.js'), u1, 'fileUrl is cached per file');
  assert.equal(ctxSeen.plugin.assetUrl('sub/b.js'), 'js/modules/studio/adv/sub/b.js');
  assert.throws(() => ctxSeen.plugin.fileUrl('nope.js'), e => e.code === 'PLUGIN_FILE_MISSING');
  assert.throws(() => ctxSeen.plugin.fileUrl('../x.js'), e => e.code === 'PLUGIN_FILE_MISSING');
  assert.throws(() => ctxSeen.plugin.assetUrl('../x.js'), e => e.code === 'PLUGIN_BAD_PATH');
  assert.throws(() => ctxSeen.plugin.assetUrl('/etc/passwd'), e => e.code === 'PLUGIN_BAD_PATH');
  PR2.disposeAll();
  assert.ok(URLShim.revoked.includes(u1), 'disposeAll revokes the blob URLs');
}

// ── 3. a failing script rejects with PLUGIN_SCRIPT_FAILED naming the file ────
{
  reset();
  await load2(baseMeta({ scripts: ['a.js', 'bad.js', 'c.js'] }), {
    'a.js': "mark('a');", 'bad.js': 'THROW', 'c.js': "mark('c');"
  });
  let ctx = null;
  PR2.implement('adv', { init(c) { ctx = c; } });
  await PR2.initAll({});
  await assert.rejects(ctx.plugin.execScripts(), e => e.code === 'PLUGIN_SCRIPT_FAILED' && e.message === 'bad.js');
  assert.deepEqual(executed, ['a'], 'scripts after the failing one do not run');
}

// ── 4. path validation: every bad entry quarantines the plugin ───────────────
const bad = [
  { scripts: ['../evil.js'] },
  { scripts: ['/abs.js'] },
  { scripts: ['a/../b.js'] },
  { scripts: ['x.css'] },
  { styles: ['x.js'] },
  { scripts: ['a.js', 'a.js'] },
  { scripts: 'a.js' },
  { scripts: [42] },
  { scripts: ['http://x/a.js'] },
  { scripts: ['back\\slash.js'] },
  { scripts: ['./a.js'] },
  { scripts: ['sp ace.js'] },
];
let badN = 0;
for (const extra of bad) {
  reset();
  const id = `bad${badN++}`;
  await load2(baseMeta({ id, ...extra }), { 'a.js': "mark('a')", 'b.js': '', 'x.css': '', 'x.js': '' });
  const q = PR2.getQuarantined().find(x => x.path === `studio/${id}`);
  assert.ok(q && q.reason === 'invalid-meta', `invalid scripts/styles ${JSON.stringify(extra)} is quarantined as invalid-meta`);
  assert.equal(PR2.getModule(id), null, `${JSON.stringify(extra)}: nothing registered`);
  assert.deepEqual(executed, [], 'nothing executed');
}

// ── 5. a declared file the trust pass did not deliver is refused ────────────
{
  reset();
  await load2(baseMeta({ id: 'miss', scripts: ['missing.js'] }), {});
  const q = PR2.getQuarantined().find(x => x.path === 'studio/miss');
  assert.ok(q && q.reason === 'invalid-meta' && /missing\.js/.test(q.detail), 'missing declared file quarantined');
}

// ── 6. a sandboxed verdict is quarantined with the studio reason ─────────────
{
  reset();
  await load2(baseMeta({ id: 'sbx' }), {}, 'sandboxed');
  const q = PR2.getQuarantined().find(x => x.path === 'studio/sbx');
  assert.ok(q, 'quarantined');
  assert.equal(q.reason, 'sandbox-unsupported-placement');
  assert.match(q.detail, /studio plugins run in the page/);
  assert.equal(PR2.getModule('sbx'), null, 'not registered');
}

// ── 7. a plugin declaring no scripts/styles keeps no bytes and a working ctx.plugin
{
  reset();
  await load2(baseMeta(), {});
  let ctx = null;
  PR2.implement('adv', { init(c) { ctx = c; } });
  await PR2.initAll({});
  await ctx.plugin.execScripts();      // nothing declared: resolves, does nothing
  assert.equal(scriptsAppended.length, 1, 'only index.js was injected');
  assert.equal(heads.length, 0);
  assert.throws(() => ctx.plugin.fileUrl('index.js'), e => e.code === 'PLUGIN_FILE_MISSING', 'no retained bytes without scripts/styles');
}

// ── 8. every placement list of the repo knows `studio` (static) ─────────────
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
assert.match(read('dev_server.py'), /PLUGIN_PLACEMENTS = \("tools", "channels", "shaders", "studio"\)/);
assert.match(read('tools/gen_plugins_manifest.py'), /PLUGIN_PLACEMENTS = \("tools", "channels", "shaders", "studio"\)/);
assert.match(read('api/plugins.php'), /\$PLACEMENTS\s*=\s*\['tools', 'channels', 'shaders', 'studio'\]/);
assert.match(read('api/admin.php'), /\(tools\|channels\|shaders\|studio\)/);
assert.match(read('api/_admin_lib.php'), /\(tools\|channels\|shaders\|studio\)/);
assert.match(read('tools/build_release.py'), /\("tools", "channels", "shaders", "studio"\)/);
assert.match(read('js/pages/admin/tab-plugins.js'), /key: 'studio'/);
assert.match(read('js/pages/admin/shell.js'), /\['shaders', 'channels', 'tools', 'studio'\]/);

console.log('test_plugin_studio_placement: ok');
