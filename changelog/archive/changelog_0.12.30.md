# Changelog 0.12.30 (Plateforme Web)

## [FIXED]
- **ResizeObserver Infinite Shrinking Loop:**
  - Updated `volume-viewer.js` to initialize the `ResizeObserver` observing the canvas parent element (`container.parentElement`) instead of the canvas element itself.
  - Refactored `init()` and `resize()` to read dimensions from `container.parentElement` rather than the canvas.
  - This solves the issue where dropping the pixel ratio dynamically during rotation (resolution downgrade to 0.4x/0.5x) triggered a feedback loop in the layout engine because the canvas's intrinsic size reduction would cause the element to shrink, triggering subsequent resize observer events infinitely until the canvas/model disappeared.
