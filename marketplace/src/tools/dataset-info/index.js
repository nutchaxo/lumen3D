/* Reference MARKETPLACE plugin (SANDBOXED). Installed from the first-party signed
   catalog into js/modules/tools/dataset-info/, then run inside a null-origin iframe:
   it has NO access to document, the ViewerContext, cookies, or the admin API — only
   the LumenPlugin SDK, which brokers a narrow capability set through the host. */
LumenPlugin.register({
  async init() {
    this.btn = LumenPlugin.addButton({ label: LumenPlugin.t('title'), icon: 'info' });
  },
  async activate() {
    try {
      const info = await LumenPlugin.getInfo();
      const name = (info && info.name) ? info.name : LumenPlugin.t('noDataset');
      const dims = (info && Array.isArray(info.dimensions)) ? info.dimensions.join(' × ') : null;
      await LumenPlugin.toast(dims ? `${name} — ${dims}` : name).catch(function () {});
    } catch (e) {
      LumenPlugin.toast(LumenPlugin.t('failed')).catch(function () {});
    }
    return { active: false };  // an action, not a persistent toggle
  },
  dispose() {}
});
