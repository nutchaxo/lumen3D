// tracking-surface fetches the model the metadata names, once, through the HTTP
// cache with revalidation: no probe of a ".gz" sibling the pipeline never writes,
// no cache bypass. A ".gz" model is decompressed unless the server already did it.
import { gzipSync } from 'node:zlib';
import { loadModule } from './harness.mjs';

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else { failures += 1; console.error(`FAIL - ${msg}`); }
}

if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' || typeof Response === 'undefined') {
  console.log('SKIP - this Node has no DecompressionStream / Blob / Response');
  process.exit(0);
}

let plugin = null;
const PluginRegistry = { implement(id, impl) { if (id === 'tracking-surface') plugin = impl; } };

function makeFetch(files) {
  const calls = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url, cache: opts.cache });
    const path = new URL(url, 'http://host/').pathname;
    if (!(path in files)) return new Response('not found', { status: 404 });
    return new Response(files[path], { status: 200 });
  };
  return { fetchStub, calls };
}

const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]); // "glTF" header

async function run() {
  const { fetchStub, calls } = makeFetch({
    '/DATA_WEB/live/ds/model.glb': glb,
    '/DATA_WEB/live/ds/model.glb.gz': gzipSync(glb),
  });
  loadModule('js/modules/tools/tracking-surface/index.js', 'undefined', {
    PluginRegistry, fetch: fetchStub, location: { href: 'http://host/viewer.html' },
    DecompressionStream, Blob, Response, URL, Uint8Array,
  });
  check(plugin && typeof plugin._fetchModel === 'function', 'plugin registered with _fetchModel');

  const plain = new Uint8Array(await plugin._fetchModel('DATA_WEB/live/ds/model.glb'));
  check(calls.length === 1, `plain model: one request (got ${calls.length})`);
  check(!calls.some(c => /\.gz$/.test(c.url)), 'plain model: no .gz probe');
  check(calls[0].cache === 'no-cache', `plain model: revalidating cache mode (got ${calls[0].cache})`);
  check(Buffer.from(plain).equals(Buffer.from(glb)), 'plain model: bytes delivered unchanged');

  calls.length = 0;
  const unzipped = new Uint8Array(await plugin._fetchModel('DATA_WEB/live/ds/model.glb.gz'));
  check(calls.length === 1 && calls[0].cache === 'no-cache', 'gz model: one revalidating request');
  check(Buffer.from(unzipped).equals(Buffer.from(glb)), 'gz model: decompressed to the GLB');

  // The server applied Content-Encoding: the body is already the GLB.
  const decoded = makeFetch({ '/DATA_WEB/live/ds/model.glb.gz': glb });
  loadModule('js/modules/tools/tracking-surface/index.js', 'undefined', {
    PluginRegistry, fetch: decoded.fetchStub, location: { href: 'http://host/viewer.html' },
    DecompressionStream, Blob, Response, URL, Uint8Array,
  });
  const passthrough = new Uint8Array(await plugin._fetchModel('DATA_WEB/live/ds/model.glb.gz'));
  check(Buffer.from(passthrough).equals(Buffer.from(glb)), 'gz model already decoded by the server: used as is');

  let threw = false;
  try { await plugin._fetchModel('DATA_WEB/live/ds/missing.glb'); } catch (_) { threw = true; }
  check(threw, 'a missing model rejects (the caller shows its translated toast)');
}

run().then(() => {
  if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
  console.log('all tracking-surface model fetch checks passed');
}, (err) => { console.error(err); process.exit(1); });
