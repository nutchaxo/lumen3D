// Regression test: ChannelPanel renders channel plugin UI (getChannelUI/syncUI)
// BEFORE PluginRegistry.initAll() runs the plugin's init(ctx) — so `this._ctx`
// is undefined at that point. The channel plugins must therefore resolve their
// i18n strings via the GLOBAL I18n singleton (with a literal fallback), never
// via `this._ctx.i18n` (which crashed dataset loading: "Cannot read properties
// of undefined (reading 'i18n')").
//
// Run: node tests/js/test_channel_plugin_preinit.mjs
import assert from 'node:assert/strict';
import { loadModule } from './harness.mjs';

function loadChannelPlugin(rel, id, i18n /* optional global */) {
  let impl = null;
  const sandbox = {
    PluginRegistry: { implement: (_id, obj) => { impl = obj; } },
    requestAnimationFrame: (fn) => fn(),
    document: {},
  };
  if (i18n) sandbox.I18n = i18n;
  loadModule(rel, '__none__', sandbox);
  assert.ok(impl && typeof impl.getChannelUI === 'function', `${id}: impl captured`);
  return impl;
}

const HISTO = 'js/modules/channels/histogram/index.js';
const GAUSS = 'js/modules/channels/gaussian-filter/index.js';
const channel = { idx: 0, min: 0.1, max: 0.9, midtone: 0.5, gamma: 1.2, color: '#ff0000', enabled: true, filterBackground: false, denoise_sigma: 1.5 };

// ── 1. getChannelUI must NOT throw when called before init (no this._ctx) ──
{
  // No global I18n at all → must fall back to literals, never throw.
  const h = loadChannelPlugin(HISTO, 'histogram', null);
  let html;
  assert.doesNotThrow(() => { html = h.getChannelUI(channel); },
    'histogram.getChannelUI must not throw before init (no _ctx, no I18n)');
  assert.match(html, /Min/, 'histogram falls back to literal "Min"');
  assert.match(html, /Ignore low/, 'histogram falls back to literal "Ignore low"');

  const g = loadChannelPlugin(GAUSS, 'gaussian-filter', null);
  let ghtml;
  assert.doesNotThrow(() => { ghtml = g.getChannelUI(channel); },
    'gaussian-filter.getChannelUI must not throw before init');
  assert.match(ghtml, /Gaussian blur/, 'gaussian falls back to literal label');
}

// ── 2. With the global I18n present, plugin keys resolve (translated) ──
{
  const i18n = {
    t: (k) => ({
      'plugins.histogram.min': 'Mín',
      'plugins.histogram.ignoreLow': 'Ignorer le fond',
      'plugins.gaussian-filter.label': 'Flou gaussien σ',
    }[k] ?? k),
  };
  const h = loadChannelPlugin(HISTO, 'histogram', i18n);
  const html = h.getChannelUI(channel);
  assert.match(html, /Mín 0/, 'histogram uses the global I18n translation');
  assert.match(html, /Ignorer le fond/, 'histogram ignoreLow translated via global I18n');

  const g = loadChannelPlugin(GAUSS, 'gaussian-filter', i18n);
  assert.match(g.getChannelUI(channel), /Flou gaussien/, 'gaussian label translated via global I18n');
}

// ── 3. histogram.syncUI must also not throw before init ──
{
  const h = loadChannelPlugin(HISTO, 'histogram', null);
  const labels = {};
  const elFor = (id) => ({ get textContent() { return labels[id]; }, set textContent(v) { labels[id] = v; }, style: {} });
  const container = {
    querySelector: (sel) => {
      if (sel.includes('lbl-min')) return elFor('min');
      if (sel.includes('lbl-mid')) return elFor('mid');
      if (sel.includes('lbl-max')) return elFor('max');
      if (sel.includes('ch-hist')) return null; // skip histogram svg render
      return { style: {} };
    },
  };
  assert.doesNotThrow(() => h.syncUI(0, channel, container, () => []),
    'histogram.syncUI must not throw before init');
  assert.ok(/^Min /.test(labels.min), 'syncUI min label uses fallback "Min"');
}

console.log('channel plugin pre-init i18n (no this._ctx crash): OK');
