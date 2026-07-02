# Changelog 0.4.31

## [OPTIMIZED]
- **Crop bounds caching**: The bounding box of the visible slice area is now computed once on the first recompose and cached as normalized ratios (`map._cropRect`). Subsequent re-renders reuse the cached bounds, eliminating a full-pixel scan (~32M pixels per 3810² canvas) on every channel adjustment. This alone removes ~80% of the per-frame CPU cost.
- **Interactive resolution scaling**: During interactive channel adjustments (slider dragging), the GPU render resolution is reduced to 50% of the original. Full resolution is used for the initial render and when all panels are updated together. This halves GPU render time during dragging with no perceptible quality loss.

## [FIXED]
- Fixed slice images stretching toward canvas borders when channel adjustments made the background transparent. Root cause: `cropEmptySpace` dynamically recomputed crop bounds every frame, and when background alpha dropped below the threshold (≤5), the detected bounds shrank, causing the smaller image to be stretched to fill the fixed cell area. Now that crop bounds are cached from the first render (where geometry is correct), the image dimensions remain stable regardless of channel modifications.
