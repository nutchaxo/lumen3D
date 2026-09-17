# Changelog v1.55.4 (Web Platform)

## [FIXED]

- **The 3D scale bar showed "200 µm" whatever the dataset**: `VolumeGrid` drew one grid cell (0.15 world units) under a fixed label, and measured the depth as the camera's Euclidean distance to the specimen centre, so a panned specimen shrank its bar. The bar is now the nearest 1-2-5 length in real µm at or below a fifth of the viewport width, read at the depth of the specimen centre along the view axis (a perspective camera shows a length L at depth d as L / (2·tan(fov/2)·d) of the viewport height); one world unit is `physical.x / cube.scale.x` µm — `computePhysicalScale` normalises the cube to the longer of X and Y, and the X axis carries no display Z override. `VolumeViewer` hands its calibration to the grid (`VolumeGrid.init({ getPhysicalSize })`); a dataset whose calibration metadata is missing gets no bar rather than a voxel count labelled in µm. Still shown with the grid only, as before. Test: `tests/js/test_scale_bar_3d.mjs` (known camera, viewport and calibration → known label and width, against the real Three.js; panning keeps the scale, zooming rescales it).
- **Closing the slice tool could leave the camera slightly zoomed out**: the pre-swap camera distance was restored while the inspector panel was still closing (a 250 ms width transition), and `VolumeViewer.resize()` fitted the volume to that interim, narrower layout, pushing the camera back again. The distance is restored a second time once the transition is over, still only if the user has not taken the camera in between.
- **The staged slice's scale bar without calibration**: the bar of the slice stage (v1.55.2) read `VolumeViewer.getPhysicalSize()` even when the metadata is missing, where the "physical" size is a voxel count; it hides in that case too.

## [ADDED]

- **`Utils.niceScaleLength(target)` and `Utils.formatMicrons(um)`**: the 1-2-5 picker and the µm / mm label, shared by the 3D bar and the staged slice's bar (the 2D viewer keeps its own drawing code).
