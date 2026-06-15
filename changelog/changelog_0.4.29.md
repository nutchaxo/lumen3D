# Changelog 0.4.29

## [FIXED]
- **Critical**: Fixed channel colorimetry modifications having no visible effect on Compare Studio slices. Root cause: `_rerenderSliceFromChannels()` was guarded by `typeof VolumeSlicer === 'undefined'` which always returned early on `compare.html` because `volume-slicer.js` is only loaded inside each iframe, not on the parent page. The guard is now split: the layoutMaps path (compare mode) uses each iframe's own `VolumeSlicer`, while only the single-slice path requires a global `VolumeSlicer`.
- Fixed resolution label (`3810 × 3810`) being clipped and overlapping with the slice background. Added a dedicated `RES_LABEL_H = 22px` space below each slice cell, factored into the canvas height calculation, and used a smaller fixed font size (11–16px) with `textBaseline: 'top'` anchoring.
