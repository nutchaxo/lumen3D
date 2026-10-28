# Changelog v1.70.1 (Web Platform)

## [FIXED]

- **Viewer broken on Android tablets (Adreno GPUs)**: the GPU-compressed display atlas (v1.60.0) put the volume on screen in RGTC blocks. On a Qualcomm Adreno 740 tablet, Chrome reaches RGTC through ANGLE's emulation. A 4 × 4 test texture passes, but a real atlas makes the driver fail (`texStorage3D`: internal error 0x500) and the WebGL context is lost. After a few losses Chrome refuses the site any WebGL context, so every dataset ended in "Error creating WebGL context", whatever its format. Two changes prevent this:
  - Compression is no longer used on mobile GPUs (Adreno, Mali, PowerVR, Xclipse, Immortalis, Vivante) or in an Android browser.
  - A device that loses its context while a compressed atlas is in use records it, and never uses compression again (`lumen3d.gpuCompressionFailed`).

  Such devices show the volume from exact voxels, as before v1.60.0.

## [CHANGED]

- **Clear message when the browser refuses WebGL**: "Error creating WebGL context" is replaced by an explanation. A browser blocks WebGL for a site after graphics driver crashes, until it is fully restarted (on Android: force-stop Chrome). The message also suggests checking hardware acceleration.

## [ADDED]

- **Tests**: `tests/js/test_svr_compressed_atlas.mjs` checks that an Adreno or Mali GPU is refused compression, and that a context lost with a compressed atlas alive refuses it from then on, on any GPU.
