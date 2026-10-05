# Changelog v1.59.0 (Web Platform)

## [ADDED]

- **Two new data updates (formats 3 and 4)**: the *Data updates* tab now brings datasets to format 4 in two steps, applied in order after the planes of format 2: **layer maximum projections** (one stored projection per 64-plane brick layer) and the **brick pyramid v3** (levels halved in Z too, 1-voxel border, binary index). A dataset at version 1 gets every step in sequence. Format 4 keeps the native level voxel for voxel. The contract shared by the browser, the Python server and the PHP server is `DOCS/dataset-migrations/SPEC.md` Part II.
- **Full resolution where you look**: when you zoom past what the loaded quality can show, the viewer streams finer bricks only for the region in view, within the GPU memory budget, and drops them when you look elsewhere. A *Zoom detail* setting (automatic / on / off) and a status line sit in the Render Quality section. Available on datasets in format 4.
- **Seamless filtering on format 4**: bricks carry a 1-voxel border and are filtered trilinearly, so brick seams disappear at every quality; coarse levels are halved in Z too (up to 4× lighter) and keep the volume's aspect ratio.
- **Lighter atlases for 1–2 channel data**: datasets with one or two channels use R8 / RG8 textures and hold 4× / 2× more bricks in the same GPU memory.
- **Choice of executor per update**: each pending update runs in the browser or on the server, whichever can run it and was measured faster, and the operator can override it; one dataset's chain can mix both. The tab says clearly when neither can run a step (e.g. a browser or a PHP host that cannot encode lossless WebP).
- **Gallery thumbnails**: the server keeps 320 px copies of gallery images; the viewer and admin grids load them instead of the originals.
- **Marketplace anti-rollback**: the signed plugin catalog carries an increasing serial, and a host refuses a catalog older than the newest one it accepted.

## [OPTIMIZED]

- **Whole-stack z-stack figures from layer projections**: a native MIP over whole brick layers reads one stored projection per 64 planes plus the planes at both ends — about 3 packs instead of 150 for a whole stack — pixel-identical to the planes and the bricks.
- **Native XZ/YZ cuts**: on format 4 each brick gives only its one-voxel plane, packs group 4×4×4 super-blocks, and the byte runs of one pack leave as one multi-range request (≈ 118 requests for an XZ and a YZ cut of a 5735² embryo instead of 686). The Python server answers multi-range requests; Apache does natively.
- **Binary brick index**: format 4 reads a compact `index.bin` (233 kB on a 3789² embryo) instead of a 7.6 MB JSON brick table, verified by its SHA-256 before use.
- **Faster imports**: a received chunk costs one 16-byte log record instead of rewriting the whole import journal.
- **Telemetry throttling**: per-address and global limits in a fixed-size table refuse a beacon flood before any statistics write.

## [CHANGED]

- **Quality labels show real dimensions**: the 512 / 1024 / native presets map to the levels the renderer really loads (on format 4: the finest level up to 768 / 1536 px), and the menu never offers two names for one level.
- **Compare asks, never reaches in**: captures, Studio slices, workspace state and channels travel between Compare and its panels as request/response messages with ids, timeouts and origin checks; pictures are transferred, and released when a panel closes or answers late.
- **Data updates on hosts with a short time limit**: on a PHP host with a ~30 s limit, a large brick-pyramid unit is processed in eight parts saved one by one; a unit the server still cannot finish is reported and continued in the browser, keeping the progress.
- **Re-import keeps curated data**: publishing an import over an existing dataset keeps its gallery and curated settings unless the new upload provides them.
- **The Import accepts formats 2 to 4**: planes, layer projections and v3 brick trees are accepted and validated (index hash, pack extents).

## [FIXED]

- **Timelapse frames never pick up another frame's bricks** when a prefetch and a load overlap, and each frame keeps its own background floor on format 4.
- **Range requests survive a server's range cap**: a server refusing several ranges at once only stops combined requests.
- **Large gallery images can no longer break dataset saves on PHP hosts**: an image too big to decode within the memory limit simply gets no thumbnail.
- **Chunk debug on format 4** (plugin 1.1.0): understands bordered bricks, per-level voxel sizes and the binary index.
