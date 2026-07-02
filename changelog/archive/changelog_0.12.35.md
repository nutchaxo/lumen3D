# Changelog 0.12.35 (Plateforme Web)

## [ADDED]
- **Explorer Preview Redefinition (Admin Panel):**
  - Added a "📸 Redéfinir la preview" button in `admpan.html` to update the dataset's explorer thumbnail.
  - Implemented `REQUEST_SCREENSHOT` and `SCREENSHOT_RESPONSE` message flow between admin parent panel and viewer iframes (`viewer.js` and `tracking.js`).
  - Added a canvas processing step inside the iframe to rescale and center the captured active canvas (handles 3D raymarching, 2D slice inspector, OpenSeadragon DeepZoom, etc.) into a `512x512` box padded with dark background `#080a12`.
  - Added `save_thumbnail` action to backend APIs (`datasets.php` and `dev_server.py`) to decode base64 WebP images and overwrite `thumbnail.webp` in the dataset directory.
- **Save Visibility & Contrast States:**
  - Persisted min, max, gamma, and active/masked states for all channels in the dataset's `metadata.json`.
  - Added a Visibility (Exposure) slider to `admpan.html` and persisted global exposure settings in metadata.
  - Implemented bidirectional `SYNC_EXPOSURE` messaging to sync the exposure slider instantly between the admin frame and the viewer iframe.

## [FIXED]
- **Viewer Script Restoration:**
  - Restored `js/pages/viewer.js` from backup to resolve a line truncation issue that had deleted 33 functions (including DeepZoom, Z-stack, Slicer overlays, etc.).
  - Fixed a syntax error in font-styling on the scale bar overlay canvas (mismatched quotes/backticks).
