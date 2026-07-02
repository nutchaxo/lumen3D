# Changelog 0.12.37 (Plateforme Web)

## [FIXED]
- **3D Volume Screenshot Capture:**
  - Fixed screenshot source selection in `viewer.js` to correctly distinguish between 3D volume mode and 2D slicer/DeepZoom modes, preventing 3D captures from incorrectly saving a 2D slice.
- **Channel Active & Contrast Level Persistence:**
  - Fixed `channel-panel.js` initialization and `setState` to support both `enabled` and `active` state keys, ensuring that unchecked channel states are preserved.
  - Implemented automatic `midtone` calculation from `gamma` during initialization and state synchronization in `channel-panel.js` when `midtone` is absent in dataset metadata, preventing custom contrast levels and gamma values from resetting to 1.0 on page reload.
