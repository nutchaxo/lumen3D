# Changelog v0.23.2 (Preprocessing)

## [CHANGED]

- **A re-run keeps the visible time range of a timelapse**: `timeRange` joins the curated keys of `metadata.json` (`CURATED_KEYS` in `run_preprocess.py`, and the same list in the browser import, `upload_staging.py` / `api/_upload_lib.php`). The operator sets it in the admin Datasets editor (first and last timepoint a visitor can reach); reprocessing or republishing the dataset no longer erases it. The pipeline never writes it and never cuts the acquisition: the bricks and the downloads still carry every timepoint.
- **The download TIFF and MIPs of a timelapse show a frame a visitor can reach**: `tools/build_download_bundles.py` now defaults `--timepoint` to the first frame of the dataset's visible time range (frame 0 without one), and the README of `download/` says which frames the site offers. A TIFF built earlier on a frame the range now hides (read back from its ImageJ info block) is rebuilt, with its MIPs and README, on the next run; a frame inside the range, or an explicit `--timepoint`, is left as it is. The `.ims` and the `_web.zip` still hold every timepoint.
