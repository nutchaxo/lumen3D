/* ============================================================
   Lumen3D — branded 404 page (404.html)
   ============================================================
   Served with status 404 by every backend for a missing page. Only
   theme, white-label brand and translations; no dataset, no catalog.
   ============================================================ */

(function () {
  'use strict';

  async function init() {
    if (typeof InstanceConfig !== 'undefined') { try { await InstanceConfig.load(); } catch (_) {} }
    if (typeof Theme !== 'undefined') Theme.init();
    if (typeof I18n !== 'undefined') { try { await I18n.init(); } catch (_) {} }
    if (typeof InstanceConfig !== 'undefined') { try { InstanceConfig.applyHead(); InstanceConfig.applyDom(); } catch (_) {} }

    if (typeof I18n !== 'undefined' && typeof InstanceConfig !== 'undefined') {
      const brand = InstanceConfig.get('brand.name');
      document.title = '404 — ' + I18n.t('app.notFoundTitle') + (typeof brand === 'string' && brand ? ' — ' + brand : '');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
