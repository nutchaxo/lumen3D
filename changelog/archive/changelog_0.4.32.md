# Changelog 0.4.32

## [FIXED]
- Fixed PNG export ignoring colorimetric modifications in Compare Studio mode. The export function was using the original `_sliceResult` (pre-modification image) as the source canvas. In compare mode, it now forces a full-resolution recompose of all panels before export, using the modified `_sliceImage`. In single-slice mode, it also detects if the current `_sliceImage` differs from the original and uses the modified version.
