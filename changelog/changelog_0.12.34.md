# Changelog 0.12.34 (Plateforme Web)

## [ADDED]
- **Active Resolution Export in Decompose Mode:**
  - Integrated dynamic resolution matching for exports inside `decomposition-panel.js`. Instead of hardcoding previews rendering size to `512px`, the system now queries the active volume dimensions using `VolumeViewer.getSamplingVolume()`.
  - When exporting, each preview block is rendered using the active volume texture size (e.g. `2048px` or `1024px`) matching the currently loaded level of detail.
  - Sized the main view's high-resolution WebGL render block to match, preventing pixelation/upscaling artifacts of the main canvas on the exported canvas.
  - Implemented a safety clamp range `[512, 4096]` for render dimensions to avoid WebGL context loss or memory overhead warnings on high-end monitors.
