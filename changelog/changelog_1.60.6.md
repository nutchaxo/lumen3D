# Changelog v1.60.6 (Web Platform)

## [OPTIMIZED]

- **Data updates tab opens without the long wait on PHP hosts**: PHP keeps nothing between requests, so every visit of the tab rebuilt the unit plan of every volume dataset. For a format-4 dataset that meant reading, hashing and decoding every `index.bin` of every timepoint, even when nothing was left to do, which took about 20 seconds on a shared host. Each dataset's status row is now cached in `uploads/migrations/.status/`, keyed on a hash of what the row depends on: metadata, bricks manifest, every `index.bin`, the pack, planes and MIP directories and their manifests, the kept previous version, the jobs' journals and the engine itself. Only the datasets that changed are recomputed, and a dataset being converted is recomputed at every unit because its journal changes. The Python server already kept its plans in memory.

## [ADDED]

- **`Server-Timing` on the status answer (PHP)**: the time `status` took and its three slowest datasets now show in the browser's network panel, so a slow tab can be diagnosed without server access.
