# Changelog v0.8.7

## [OPTIMIZED] Multi-Texturing Architecture for LOD0
- **Bypass WebGL Memory Limits**: Implemented a multi-texturing architecture to bypass the hard 1GB `GL_INVALID_OPERATION` limit in WebGL2 `glTexStorage3D`. Instead of creating a single massive RGBA 3D texture (1.09 GB for LOD0), the engine now dynamically allocates up to 4 independent `RedFormat` textures (1 byte per voxel, ~272 MB each).
- **Reduced VRAM Usage**: Memory footprint for a 3-channel volume is reduced by 25% since the unused Alpha channel is no longer allocated in VRAM.
- **Shader Update**: The `fragmentShader` in `volume-viewer.js` now samples from `map0`, `map1`, `map2`, and `map3` simultaneously, preserving the exact same visual quality and blending behavior for DVR and Emission modes.
- **Brick Loader Unpacking**: Bricks stream natively in RGBA and are unpacked dynamically into their respective channel textures directly within JavaScript, preventing double-buffering large arrays.
- **Histogram Computation**: Fixed the background histogram parser (`_computeChannelHistograms`) to iterate across the multi-texture buffers instead of the legacy interleaved buffer.
