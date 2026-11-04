## [ADDED]
- **Fine empty-space cells for a dense volume (opt-in, `?denseCells=1`)**: a volume held as one dense texture (the usual case of a 512 level on a device without GPU-compressed atlases) now can carry the 8³ cell maxima an atlas already had. The cells are computed in the decode worker on the interior box of each brick, published as an RGBA8 texture dilated by one cell in each direction (a trilinear sample reaches one voxel into the neighbour cell), and read by the same `fineCellSkips` the atlas path uses. A brick in flight reads 255 (never skipped), a brick the level does not store reads 0.
- **`?rawCache=0`**: turns the maximum-projection maxima cache off (the classic single pass), to compare on a device. The `?perf=1` readout now shows `dense +cells` and `cache on/off`.

## [OPTIMIZED]
- **A cell that cannot raise the ray's maximum is skipped (maxima march)**: in the maxima march of the maximum projection a cell whose per-channel maxima are all under the maximum the ray already holds changes nothing (a sample is an interpolation of voxels no brighter than the cell's maximum), so it is jumped over; exact, with half a level of margin for filtering units that round their weights. Measured on F6TEST-E85 native it changes the image by at most 2/255 against the classic pass and gains little over the empty-cell skip (30.2 against 30.6 ms from the side): the maximum of a 10³ block usually exceeds what a single ray line has met.

## [CHANGED]
- **The cell test is one function for the atlas and the dense path** (`fineCellSkips`); the cell sampler declarations moved out of the atlas-only block.

## [NOTE]
- **Why the dense cells are opt-in**: on a desktop GPU (RTX 4070, 1024×1024×72 dense, 1760×1482 buffer) they make the frame slower, 4.5 against 6.6 ms along z, because one cheap dense fetch per sample costs less than the skip logic saves. On a mobile GPU where texture reads dominate it may be the other way round; that is for `?perf=1` on the device to say, with `?denseCells=1`, `?rawCache=0` and `?renderScale=0.5` as the comparisons.
