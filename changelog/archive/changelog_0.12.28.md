# Changelog 0.12.28 (Plateforme Web)

## [ADDED]
- **Active Bricks Verification API :**
  - Implemented `BrickLoader.hasBrick(bx, by, bz, lod)` inside `brick-loader.js` to perform quick O(1) checks against active chunks loaded from the manifest.

## [OPTIMIZED]
- **Upgraded SVR Atlas Allocation capacity :**
  - Updated `SVRManager` configuration to request a single-page 1024x1024x512 RGBA8 texture on modern GPUs (yielding 2048 slots and exploiting ~2 GB VRAM memory capacity).

## [FIXED]
- **WebGL Client Dynamic Downgrade Loop :**
  - Corrected `loadBrickedVolumeStream` in `volume-viewer.js` to calculate the dynamic limit `MAX_ALLOWED_BRICKS = _svrManager ? _svrManager.maxSlots : 2048`.
  - Refactored the safety downgrade check to compute `activeBricksCount` by filtering required bricks via `BrickLoader.hasBrick` (instead of using raw bounding-box totals). This ensures LOD0 selection correctly honors the physical sparsity of the active volume chunk structure.
