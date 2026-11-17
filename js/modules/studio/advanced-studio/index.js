/* Advanced Studio — index.js
 *
 * Registers the 'advanced' mode of the Studio. Everything heavy (ij-core, ij-analysis,
 * ij-view, ij-app and the stylesheet) is declared in plugin.json and only runs the first
 * time the operator opens the Advanced view (ctx.plugin.execScripts), so a viewer that
 * never uses it pays for this file alone. The worker scripts (ij-engine.js, ij-worker.js)
 * are fetched by the worker itself.
 */
(function () {
  PluginRegistry.implement('advanced-studio', {
    init(ctx) {
      if (!ctx.studio || typeof ctx.studio.registerMode !== 'function') return;
      const t = (key, params) => ctx.i18n.t(key, params);

      ctx.studio.registerMode({
        id: 'advanced',
        label: () => t('mode'),
        icon: 'microscope',

        // The Studio asks before it shows the switch: the source says whether the
        // figure on screen is an axis-aligned plane of a volume it can read.
        eligible() {
          let d = null;
          try { d = ctx.studio.source.describe(); } catch (err) { console.error('[advanced-studio] describe failed', err); }
          if (d && d.available) return { ok: true };
          return { ok: false, reasonKey: (d && d.reasonKey) || 'studioAdvanced.notSupported' };
        },

        async mount(root, api) {
          await ctx.plugin.execScripts();
          IJApp.mount(root, { ctx, api });
        },
        unmount() {
          if (typeof IJApp !== 'undefined') IJApp.unmount();
        },
        canLeave(reason) {
          return typeof IJApp === 'undefined' ? Promise.resolve(true) : IJApp.canLeave(reason);
        },
        hasUnsavedWork() {
          return typeof IJApp !== 'undefined' && IJApp.hasUnsavedWork();
        },
        // The Studio closed (or opened another figure) while this view was hidden behind the
        // Simple view: unmount() never runs again then, so the Studio calls release() — and
        // dispose(), the same hook under its other name — to free the worker, the GL context
        // and the documents.
        release() {
          if (typeof IJApp !== 'undefined') IJApp.release();
        },
        dispose() {
          if (typeof IJApp !== 'undefined') IJApp.release();
        }
      });
    },
    activate() {},
    deactivate() {}
  });
})();
