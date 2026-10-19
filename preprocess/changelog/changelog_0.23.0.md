# Changelog v0.23.0 (Preprocessing)

## [ADDED]

- **Format 6 (`--format 6`, now the default)**: each level is written losslessly and in WebP quality 30, the only display quality of the web platform from 1.70. The cut stores (XY / XZ / YZ planes, oblique cut bricks), `planes/` and `mips/` are unchanged. `format5.write_tree(..., fmt=6)` and `manifest_v5(..., fmt=6)` produce the tree and its `iribhm-bricks-v6` manifest. The lossless column and the stores are byte for byte those of format 5, and each Q30 brick is the one the `m006-q30` data update makes from the same lossless brick. `--format 5` still writes the five-compression matrix.

## [CHANGED]

- **Catalog**: `metadata.json` `formatVersion` is 6 when the bricks form a complete format-6 tree.

## [FIXED]

- **Format 5 / 6 from a repository checkout**: step 2 started its worker pool before the packer added the repository root (where `format5.py` lives) to the import path. The workers could not unpickle a format-5 or 6 task, and the run stopped with "No module named 'format5'". Step 2 now puts the root on its path before the pool starts. The pipeline pack, where `format5.py` sits beside the scripts, was not affected.
