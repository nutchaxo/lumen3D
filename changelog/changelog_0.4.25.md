# Changelog v0.4.25

## [ADDED]
- **Dataset labels in Compare Studio:** Each slice now displays the dataset name (left-aligned) and actual canvas resolution (right-aligned) in a header strip above the image.

## [OPTIMIZED]
- **Better cell sizing:** Replaced per-cell cap (2048px) with a total canvas cap (8192px). Cells now use the maximum resolution that fits within the canvas limit, resulting in larger slices that fill more of the viewport.
- **Edge-to-edge fill:** Removed contain-fit logic since all slices from renderHighRes are square. Slices now fill their cells completely with no wasted padding.
