# Changelog v1.66.0 (Web Platform)

## [ADDED]

- **OME-Zarr export in the Download Center**: in the viewer, the Download Center offers the lossless voxels of the open volume as one `<folder>.ome.zarr.zip` file that napari, Fiji, zarr-python and Neuroglancer read. It is an OME-NGFF 0.5 store on Zarr v3, calibrated in micrometres, with the channel names, colours and display windows. You choose the levels (native first, each with the size it reads) and the channels. The export runs in the browser from the dataset's lossless bricks, so it works on every host, a PHP web space included, with no server work.
- **Progress and cancel**: the export shows the percentage, the level, channel and brick layer being written, the bytes written and the time left, and it can be cancelled at any moment. Where the browser allows it, the file is written straight to the chosen place on disk, so its size is not limited by memory. Elsewhere it is assembled in memory, with a warning above 1.5 GB.

## [OPTIMIZED]

- **Storage layout**: each 64³ brick becomes one inner chunk of a sharded array (shards of 16 × 16 bricks of one brick layer). The shards are encoded in a worker, and all-zero chunks and shards are not written. On a 1946² × 72 three-channel embryo, all four levels came to 132 MB in 32 s.

## [FIXED]

- **Tests**: `tests/js/test_ome_zarr.mjs` exports a synthetic two-level, two-channel volume through the real worker. Python reads the zip back and checks the NGFF metadata, every shard index and its CRC-32C, and the voxels against the source, edges and absent bricks included. zarr-python ≥ 3, when installed, opens the store and reads the same values.
