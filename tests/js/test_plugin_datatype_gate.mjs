// Unit tests for the data-type gate in js/core/plugin-registry.js (loadModules).
//
// The rule is two-way and name-agnostic:
//   - a plugin DECLARING `dataTypes` runs on those dataset types and on no other
//     (this is what keeps a photograph-only tool off the volume viewer);
//   - a plugin declaring NOTHING predates the field and was written for the volume
//     viewer, so only a host passing `allowUndeclaredDataTypes` takes it;
//   - a host passing no `dataType` at all is unfiltered (back-compat).
//
// Run: node tests/js/test_plugin_datatype_gate.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

// Three plugins standing for the three cases above.
const PLUGINS = {
  'tools/photo-only':   { id: 'photo-only',   name: 'Photo only',   placement: 'tools', dataTypes: ['wholemount'] },
  'tools/cross-type':   { id: 'cross-type',   name: 'Cross type',   placement: 'tools', dataTypes: ['fixed', 'live', 'wholemount'] },
  'tools/undeclared':   { id: 'undeclared',   name: 'Undeclared',   placement: 'tools' },
};
const ALL = Object.keys(PLUGINS);

function freshRegistry() {
  const document = {
    createElement: () => ({ dataset: {}, setAttribute() {}, onload: null, onerror: null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    // The registry executes a plugin from a Blob URL; resolve it as a clean load.
    body: { appendChild: el => queueMicrotask(() => el.onload && el.onload()) },
  };
  return loadModule('js/core/plugin-registry.js', 'PluginRegistry', {
    document,
    window: {},
    I18n: { t: k => k, translateDOM() {} },
    queueMicrotask,
    // Trust is a mandatory dependency of loadModules (fail-closed). Stub it as a
    // dev-tier vouch so these tests exercise the data-type gate, not the trust gate.
    PluginTrust: { evaluate: async () => ({ tier: 'dev', hash: 'stub', bytes: '' }) },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class { constructor() {} },
    fetch: async (url) => {
      const m = String(url).match(/js\/modules\/(.+)\/plugin\.json$/);
      if (m && PLUGINS[m[1]]) return { ok: true, status: 200, json: async () => PLUGINS[m[1]] };
      return { ok: false, status: 404 };
    },
  });
}

async function loadedIds(opts) {
  const PR = freshRegistry();
  await PR.loadModules('js/modules', ALL, opts);
  // Array.from: the registry runs in its own vm realm, so its arrays fail a
  // prototype-strict deepEqual until they are re-created here.
  return Array.from(PR.listByPlacement('tools'), p => p.id).sort();
}

// No dataType: every discovered plugin loads, exactly as before the gate existed.
assert.deepEqual(await loadedIds(undefined),
  ['cross-type', 'photo-only', 'undeclared'], 'no dataType → unfiltered');

// Strict host (the 2D photograph page): only plugins that name the type.
assert.deepEqual(await loadedIds({ dataType: 'wholemount' }),
  ['cross-type', 'photo-only'], 'strict host keeps only the declaring plugins');

// Volume viewer: keeps its legacy (undeclared) plugins AND the cross-type ones,
// but must NOT pick up a plugin that declares another type only. This is the
// regression that put Split View on the 3D/Live toolbar.
assert.deepEqual(await loadedIds({ dataType: 'fixed', allowUndeclaredDataTypes: true }),
  ['cross-type', 'undeclared'], 'volume viewer drops the photograph-only plugin');
assert.deepEqual(await loadedIds({ dataType: 'live', allowUndeclaredDataTypes: true }),
  ['cross-type', 'undeclared'], 'same on live datasets');

// A declared-but-unmatched type is not a fault: nothing gets quarantined for it.
{
  const PR = freshRegistry();
  await PR.loadModules('js/modules', ALL, { dataType: 'fixed', allowUndeclaredDataTypes: true });
  assert.equal(PR.getQuarantined().length, 0, 'left-out plugins are not quarantined');
}

console.log('OK  data-type gate: %d assertions', 6);
