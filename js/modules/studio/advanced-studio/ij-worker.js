/* ij-worker.js — bootstrap of the Advanced Studio worker. The page starts it by URL
 * (new Worker(assetUrl)) and sends
 *   { init: { scripts: [blob URLs of ij-core.js, ij-analysis.js, ij-proc-shared.js, ij-engine.js],
 *             packages: [{ pkg, url }, …]   (ij-proc-<pkg>.js, each optional), budgetBytes } }
 * first; everything else is IJEngine.
 *
 * The four `scripts` are mandatory. Each package is loaded in its own try/catch: one that cannot
 * load (a syntax error, a missing file) is reported as { event: 'packageFailed', pkg } and the ops
 * it had already registered are withdrawn, so its commands are disabled by the page and a journal
 * entry naming one of its ops stops the replay instead of crashing the worker.
 *
 * When the start fails (a mandatory script cannot be loaded, the engine throws) the worker says so
 * with { event: 'initError', code: 'IJ_WORKER_INIT' } and then ANSWERS every request it receives
 * with an IJ_WORKER_INIT error: a request must never stay pending on a worker that is alive but
 * has no engine. */
'use strict';
self.onmessage = function (ev) {
  const init = ev.data && ev.data.init;
  if (!init) return;
  self.onmessage = null;
  try {
    importScripts.apply(self, init.scripts);
    const failed = [];
    for (const p of init.packages || []) {
      const reg = self.IJOpRegistry;
      const before = reg ? reg.list() : [];
      try {
        importScripts(p.url);
      } catch (err) {
        console.error('[ij-worker] package ' + p.pkg + ' failed', err);
        if (reg) for (const name of reg.list()) if (before.indexOf(name) < 0) reg.unregister(name);
        failed.push(p.pkg);
      }
    }
    self.IJEngine.start(self, { budgetBytes: init.budgetBytes, storage: 'indexeddb' });
    for (const pkg of failed) self.postMessage({ event: 'packageFailed', pkg: pkg });
  } catch (err) {
    console.error('[ij-worker] start failed', err);
    self.onmessage = function (e) {
      const m = e.data;
      if (m && m.id !== undefined && m.cmd) {
        self.postMessage({ id: m.id, ok: false, error: { code: 'IJ_WORKER_INIT', message: 'the engine did not start', details: null } });
      }
    };
    self.postMessage({ event: 'initError', code: 'IJ_WORKER_INIT' });
  }
};
