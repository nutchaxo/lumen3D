/* Decompose by Channel — index.js
 *
 * DecompositionPanel is already self-initializing via DOMContentLoaded
 * in decomposition-panel.js. This module simply registers the tool in
 * the PluginRegistry so it appears in the module manifest and its button
 * state is properly tracked.
 *
 * The actual toggle logic (btn-toggle-decomposition click binding, window
 * management, etc.) stays in DecompositionPanel, which is the source of truth.
 */
PluginRegistry.implement('decompose-channels', {
  _ctx: null,

  init(ctx) {
    this._ctx = ctx;
    return this;
  },

  activate() {
    // Delegate to DecompositionPanel which owns this button
    const btn = document.getElementById('btn-toggle-decomposition');
    if (btn) btn.click();
  },

  getState() {
    // DecompositionPanel manages its own state, nothing extra to persist
    return null;
  },

  dispose() {}
});
