# Changelog 0.12.31 (Plateforme Web)

## [FIXED]
- **Canvas Shrinking in Decompose by Channel Mode:**
  - Corrected `_renderDecompositions()` and `_exportImage()` inside `decomposition-panel.js` to read and compute the logical original canvas size by dividing `renderer.domElement.width`/`height` by `renderer.getPixelRatio()` (rather than dividing by `window.devicePixelRatio`).
  - Restored the original canvas size at the end of rendering using `renderer.setSize(origWidth, origHeight, false)` directly.
  - This solves the issue where moving/rotating the 3D model during "Decompose by channel" mode triggered an infinite shrinking loop. The loop was caused because the child preview rendering temporary `setSize()` calls would write back scaled dimensions, which were then incorrectly divided by the system's `devicePixelRatio` instead of the active `getPixelRatio()` (0.4x/0.5x during interaction), leading to exponential shrinkage on subsequent frames.
