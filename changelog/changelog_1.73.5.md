# Changelog v1.73.5 (Web Platform)

## [FIXED]

- **Viewer left half-initialised since 1.73.2**: removing the GPU memory and GPU compression selects left a call to the deleted `_bindGpuCompressionControls()` in the page's setup, which threw a `ReferenceError` and stopped everything after it. The channel panel and the render-mode (shader) choice never appeared and the volume was drawn with default, dull settings. The setup now calls `_forgetGpuSettings()` instead, which also erases the stale manual GPU settings the 1.73.2 notes promised to drop.
