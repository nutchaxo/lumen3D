# Changelog 0.4.30

## [OPTIMIZED]
- **Major performance improvement** for Compare Studio channel adjustments: only the active panel is now re-rendered (GPU recompose) when modifying colorimetry, instead of re-rendering ALL panels on every change. This reduces GPU render calls from N to 1 per adjustment.
- Added `willReadFrequently: true` to the `cropEmptySpace` canvas context, eliminating the Chrome performance warning about repeated `getImageData` readback operations.

## [FIXED]
- Resolution text below each slice is now dynamically sized (proportional to cell height, `cellH * 0.032`, min 14px) instead of being a fixed 11-16px. Added `px` suffix for clarity (e.g. `3810 × 3810 px`).
- Resolution label height below each slice is now dynamically computed (`maxSliceH * 0.035`, min 28px) to properly accommodate the text without clipping, and scales correctly with the canvas.
