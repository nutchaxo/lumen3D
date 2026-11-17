/* ij-worker.js — bootstrap of the Advanced Studio worker. The page starts it by URL
 * (new Worker(assetUrl)) and sends { init: { scripts: [blob URLs of ij-core.js,
 * ij-analysis.js, ij-engine.js], budgetBytes } } first; everything else is IJEngine. */
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
    self.postMessage({ event: 'initError', code: 'IJ_WORKER_INIT' });
  }
};
