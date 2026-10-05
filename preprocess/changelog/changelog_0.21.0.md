# Changelog v0.21.0 (Outil de Preprocessing)

## [ADDED]
- **Format 4 written directly**: the pipeline publishes the v3 brick pyramid, the XY planes and the layer maximum projections with `formatVersion: 4` (`DOCS/dataset-migrations/SPEC.md` Part II), so a freshly processed dataset needs no update in the admin *Data updates* tab; the result is byte-identical to a format-2 dataset migrated by the platform.
- **Layer MIPs**: `mips/` holds, for every 64-plane brick layer and channel, the per-voxel maximum of the native planes, so whole-stack z-stack figures read one picture per layer.
- **Surfaces for every tracking source**: a timelapse whose tracking comes from the Imaris objects inside the `.ims`, from the statistics workbook, or from a container exported without its `.glb` now gets a `model.glb`, rebuilt with the tracking pipeline's own surface reconstruction and GLB encoder (same parameters, same node layout); `metadata.tracking.surfaceOrigin` says whether it was exported or reconstructed.
- **Alignment check at import**: the importer records how many tracked positions fall inside the volume's acquisition box and names the probable unit when they do not fit, instead of publishing misplaced tracks silently.

## [CHANGED]
- **Levels halved in Z too**: each level is the integer mean (rounded half up) of the 2×2(×2) block of the previous one; Z is halved only while the voxel stays no coarser in Z than in XY, the aspect ratio is kept, and the former square 256·2^k bilinear ladder is gone. Coarse levels are up to 4× lighter.
- **Bricks with a 1-voxel border**: 66³ bricks in a 9×8 lossless WebP mosaic, so the viewer filters across bricks without seams; packs hold whole 4×4×4 super-blocks (≤ 64 bricks / 16 MiB) so XZ/YZ cuts read few packs; a binary `index.bin` replaces the large JSON brick table (233 kB instead of a 7.6 MB manifest on a 3789² embryo).
- **Exact empty-space skipping**: a brick is kept as soon as one voxel is non-zero; faint signal the former occupancy tolerance dropped is now kept.
- **Tracking positions converted to micrometres**: Imaris spot positions stored in mm, nm or m are converted with the same unit table as the volume extent, so tracks line up with the volume; an unknown unit is left unconverted and reported in the tracking provenance.
- **All-or-nothing publish covers mips/**: `mips/` is swapped with `bricks/` and `planes/`, and an outdated `planes/` or `mips/` is removed in the same swap.

## [FIXED]
- **Cell identity no longer crashes on a sudden count jump**: a track whose spot count more than doubles in one frame no longer aborts the whole tracking; the extra spot starts a new cell without a parent.
- **Faster cell-identity pass**: each track is matched from its own rows instead of scanning the whole table at every frame (identical output).
- **Repaired video export and lighter dependencies**: the truncated comparison video in `Analysis.py` is complete, plotting libraries load only when used, orjson is optional, and the worker count can be capped and respects the Windows limit.

## [OPTIMIZED]
- **Bounded memory**: levels are reduced two planes at a time and bricks are encoded one row of super-blocks at a time; no whole level of a large volume is held in RAM.
