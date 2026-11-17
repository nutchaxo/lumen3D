/* ij-worker.js — bootstrap of the Advanced Studio worker. The page starts it by URL
 * (new Worker(assetUrl)) and sends { init: { scripts: [blob URLs of ij-core.js,
 * ij-analysis.js, ij-engine.js], budgetBytes } } first; everything else is IJEngine.
 *
 * When the start fails (a script cannot be loaded, the engine throws) the worker says so with
 * { event: 'initError', code: 'IJ_WORKER_INIT' } and then ANSWERS every request it receives with
 * an IJ_WORKER_INIT error: a request must never stay pending on a worker that is alive but
 * has no engine. */
'use strict';
self.onmessage = function (ev) {
  const init = ev.data && ev.data.init;
  if (!init) return;
  self.onmessage = null;
  try {
    importScripts.apply(self, init.scripts);
    self.IJEngine.start(self, { budgetBytes: init.budgetBytes, storage: 'indexeddb' });
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
