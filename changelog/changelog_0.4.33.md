# Changelog 0.4.33

## [ADDED]
- Per-panel **Grid** and **Axes** toggle buttons in Compare mode. Each panel now has two small buttons at the bottom-right:
  - **Grid** (grid-3x3 icon): Cycles through 3 modes (off → coarse grid → fine grid → off), same as the main viewer.
  - **Axes** (axis-3d icon): Toggles the 3D coordinate axes overlay on/off.
- Buttons use glassmorphism styling with subtle backdrop blur, and light up with the primary color when active.
- Each button operates independently per panel — you can have grid on panel 1 and axes on panel 2.

## [FIXED]
- Fixed the `TOGGLE_VISUAL` postMessage handler in `viewer.js` which called non-existent API methods (`setGridParams`, `setAxesParams`). Now correctly calls `VolumeViewer.setGridMode(mode)` and `VolumeViewer.setAxesVisible(bool)`.
