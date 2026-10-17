# Changelog v1.67.0 (Web Platform)

## [ADDED]

- **Lossless once the view rests**: on a format-5 dataset shown in a compressed cell of the quality matrix (±2, ±4, light, very light), the bricks in view are streamed again from the lossless column a moment after the camera stops, at the level on screen and also at the finer levels when you zoom in. A still picture is therefore exact: in the browser, 512 at ±2 at rest matched 512 lossless pixel for pixel, against 17,390 differing pixels without it. A checkbox under the matrix turns it off; the setting is kept in the browser.
- **GPU memory setting**: a browser never tells a page how much memory the graphics card has, so the viewer estimates it (4 GB for a dedicated card, 1–2 GB for integrated graphics). *Render quality › GPU memory* now lets you give the real figure (2 to 24 GB), kept in the browser. With 8 GB, a level of up to about 7 GB can be loaded instead of 4 GB.

## [CHANGED]

- **Clearer GPU numbers**: the quality matrix legend now says what each number is. A cell shows the size to download. The GPU figure of a row is the memory the level takes once loaded, the same in every column, because the GPU holds the decompressed voxels. When a resolution is refused, the notice gives the memory actually left for the volume, how much of the budget other loaded volumes hold, and, when the budget is an estimate, where to set the real one.

## [OPTIMIZED]

- **Cut stores decoded in workers**: the tiles of XZ / YZ cuts and the cut bricks of oblique cuts are decoded in a small pool of workers (`js/workers/cut-decode-worker.js`, which runs `CutStore`'s own code), several at a time, instead of on the page's thread. On a 1946² × 72 embryo, 294 cut bricks were read and decoded in 0.18 s.

## [FIXED]

- **Tests**: `tests/js/test_format5_reader.mjs` decodes the same XZ rows through the worker pool and checks that they are identical to the page-thread decode.
