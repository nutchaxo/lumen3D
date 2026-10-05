# Changelog v0.19.0 (Outil de Preprocessing)

## [CHANGED]
- **Re-processing keeps the lab's curation**: a dataset that is processed again keeps what the admin panel set on it — a hidden dataset stays hidden, and its name, description, hand-corrected stage and embryo, orientation, sample side, default view, exposure, per-channel display settings, gallery, links and tracking block all survive. Only what the acquisition measures is refreshed (`run_preprocess.CURATED_KEYS`, `merge_curated`, `4-catalog_generator.merge_volume_metadata`); a calibration entered by hand is kept when the file carries none.
- **A dataset is published all or nothing**: a run builds the whole dataset in a private staging tree and publishes it with a handful of renames, `metadata.json` last. The published dataset keeps serving its previous bricks for the whole run, a failure at any point leaves it exactly as it was, and a swap interrupted by a crash is finished or undone on the next run.
- **Smaller manifests**: `bricks/manifest.json` is written as compact JSON (indentation alone doubled it) and lists only the bricks that hold a voxel the viewer can draw; the per-channel histograms are written by the packer for every timepoint.

## [OPTIMIZED]
- **Large volumes no longer need the whole channel in memory**: step 2 reads each channel from the `.ims` in tiles with a 5-voxel halo and levels them independently; the output is byte-identical to levelling the whole volume at once, whatever the tiling (`LUMEN_PREPROCESS_TILE_MVOX` sets the tile size).
- **A timelapse keeps one frame of temporary files**: each timepoint is packed as soon as it is levelled and its LOD files are deleted, so the temporary disk holds one frame instead of the whole acquisition.

## [FIXED]
- **Correct stages from the lab's file names**: `E8-5` → E8.5, `E10-5` → E10.5, `E10.5` → E10.5, compact `E105` → E10.5; an `Em<n>` token or the number right after a whole-day stage (`E8-1-…`) is the embryo. The 2D photograph importer now uses the same parser (it read `E10.5` as no stage and `E8-5` as E8).
- **Calibration is never invented**: a file whose extent is missing is no longer given a 1/N µm voxel labelled "exact" — the calibration is left undeclared; an extent written in mm, nm or m is converted to µm.
- **Download bundle for timelapses**: `--timepoint` chooses the frame the bundle is built from.
- **The launcher ships the tracking attachment and pinned dependencies**: `run_preprocess.bat` embeds `5-tracking_importer.py` and `tracking_sources.py`, installs pinned numpy/scipy/h5py/Pillow/tqdm versions, and extracts the download tool from the right embedded block.
