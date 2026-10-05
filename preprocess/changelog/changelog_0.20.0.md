# Changelog v0.20.0 (Outil de Preprocessing)

## [ADDED]
- **XY planes written by the pipeline (data format 2)**: step 3 re-cuts the native level into `planes/` — one pack per z of 512² greyscale PNG tiles with a fixed-size index (`lumen-planes-v1`, `DOCS/dataset-migrations/SPEC.md`) — straight from the LOD0 data it is packing, one plane per channel per worker so memory stays bounded. Voxels of bricks dropped by empty-space skipping are 0. The Studio reads these planes for native XY cuts and z-stack figures instead of whole brick layers; the result is pixel-identical to what the admin *Data updates* migration produces from an already published dataset.
- **`formatVersion: 2` in metadata.json**: a freshly processed volume says it carries format 2, so the platform does not offer to migrate it. The key belongs to the pipeline and is never carried over by the curation merge; it is claimed only when every tree's planes name the current bricks manifest.

## [CHANGED]
- **planes/ is published with the dataset**: the staging swap moves `planes/` together with `bricks/` and the thumbnail, so a re-processed dataset never mixes planes from two runs.
- **planes_writer.py shipped**: the self-contained launcher and the pipeline pack embed the new module.
