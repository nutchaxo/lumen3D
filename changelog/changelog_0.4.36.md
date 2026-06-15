# Changelog 0.4.36

## [FIXED]
- **Visual Tools Positioning**: Moved the per-panel visual tools (Grid, Axes, Z-Stack) from the bottom-right to the **top-right** (just below the panel settings/close buttons). This prevents them from overlapping with the Measure Tool floating UI and keeps all panel controls grouped logically in the same corner.
- **Z-Stack Animation**: Restored the smooth sliding animation when the Z-Stack Browser appears/disappears. The animation was previously broken because the global `.hidden` class forced `display: none !important;`, which disables CSS transitions. It now uses a dedicated `.zstack-hidden` class that properly animates `width` and `opacity`.
