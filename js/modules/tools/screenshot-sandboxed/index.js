/* Reference SANDBOXED plugin. Runs inside a null-origin iframe: it has NO access to
   document, the ViewerContext, cookies, or the admin API — only the LumenPlugin SDK,
   which brokers a narrow set of capabilities through the host. Contrast with
   js/modules/tools/screenshot/index.js (in-page, calls ExportManager directly). */
LumenPlugin.register({
  async init() {
    this.btn = LumenPlugin.addButton({ label: LumenPlugin.t('title'), icon: 'camera' });
  },
  // Invoked by the host on a real toolbar click → opens the download gesture window.
  async activate() {
    try {
      const bytes = await LumenPlugin.getCanvasBlob({ mime: 'image/png', quality: 0.95 });
      const info = await LumenPlugin.getInfo();
      const name = (info && info.name ? info.name : 'viewer').replace(/[^\w.-]+/g, '_');
      await LumenPlugin.download(`${name}_screenshot.png`, 'image/png', bytes);
      LumenPlugin.toast(LumenPlugin.t('saved'));
    } catch (e) {
      LumenPlugin.toast(LumenPlugin.t('failed'));
    }
    return { active: false };  // an action, not a persistent toggle
  },
  dispose() {}
});
