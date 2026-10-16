# Changelog v0.22.0 (Outil de Preprocessing)

## [ADDED]
- **Format 5 on request**: `run_preprocess.py --format 5` (and `2-image_processor.py --format 5`) publishes the resolution × compression matrix of `DOCS/dataset-migrations/SPEC.md` Part III instead of format 4. It has levels at 256·2ᵏ below the native size with every slice kept, made by an exact area average of the native voxels, five compressions per level, xy/xz/yz plane packs and cut bricks. The output is byte-identical to a format-4 dataset migrated by the platform's m005. The default stays format 4 until the viewer reads format 5 (web 1.64).
- **Shared module in the pack**: the pipeline pack ships `format5.py` beside the scripts. It is the same file the web platform uses, so the two producers cannot drift apart.

## [CHANGED]
- **Format detection**: `4-catalog_generator.py` reports `formatVersion: 5` when the format-5 tree, the planes and the layer MIPs are all complete.
