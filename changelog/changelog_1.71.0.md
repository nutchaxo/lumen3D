# Changelog v1.71.0 (Web Platform)

## [OPTIMIZED]

- **GPU-compressed display atlas for every volume**: the *GPU compression* setting in *Automatic* mode now compresses the atlas of every bricked volume, not only timelapses, wherever the GPU holds RGTC blocks (BC4 / BC5). Nothing is reprocessed: the decode worker encodes each brick as it is loaded, and the files on disk do not change. A three-channel volume takes 1.5 bytes per voxel instead of 4 (BC5 + BC4 against RGBA8, which also drops the unused fourth channel). On E8.5 Em1: 288 MB instead of 702 MB at native resolution, 101 MB instead of 246 MB at 1024. Measured on 120 real Q30 bricks, the blocks add 0.1 to 0.25 dB of error on top of the Q30 (PSNR 45 to 51 dB against the Q30 bricks), and the rendered 3D view differs from the RGBA8 one by 0.25 grey levels out of 255 on average. At a projected 4096 level the atlas falls from about 3.0 GB to 1.3 GB, which brings that level within the budget of an integrated GPU. Display only: exports and measurements still read the lossless data.
- **Three-channel atlas without the wasted byte**: when blocks cannot be used (a GPU without RGTC, a software renderer, a mobile GPU, or *GPU compression* set to *Off*), a three-channel volume is stored in two textures per page, RG8 for channels 0 and 1 and R8 for channel 2, instead of one RGBA8 texture. That is 3 bytes per voxel instead of 4, with identical pixels (526 MB instead of 702 MB at native resolution on E8.5 Em1; the rendered view differs from the RGBA8 one by at most 1 grey level out of 255 on one pixel). A split atlas is limited to four pages, so a level whose split layout does not fit them keeps RGBA8. One-, two- and four-channel volumes, the region-of-interest detail atlas and the dense textures of small levels are unchanged.

## [CHANGED]

- **Automatic GPU compression**: the first option of the *GPU compression* select is now called *Automatic* (it was *Timelapses*) and means "every bricked volume the GPU supports". *On* behaves the same way; *Off* keeps exact voxels.

## [ADDED]

- **Tests**: `tests/js/test_svr_split_atlas.mjs` covers the split layout (two textures per page, four pages at most, 3 bytes per voxel, the define and its removal, the dropped fourth byte, refused sub-box and block uploads, what is not split, a budget that refuses RGBA8 and accepts the split layout).
