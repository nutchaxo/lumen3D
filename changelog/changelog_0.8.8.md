# Plateforme Web v0.8.8

### [OPTIMIZED]
- Implemented sub-pixel UV shifting in the WebGL fragment shader (\uvShift\) to perfectly align downscaled LODs (LOD1, LOD2) with the native LOD0, compensating for the sub-pixel center-of-mass shift inherently introduced by image processing downscaling algorithms (e.g. \PIL.Image.resize\).
- Fixed a UX issue where the blocking loading overlay ("Loading Volume Data...") would appear on every resolution switch by correctly evaluating \ctiveEntry.textures\ instead of the deprecated \data\ property in \iewer.js\.
- Implemented progressive LOD resolution upgrading by creating \_seedTexturesFromActive()\ which interpolates existing low-resolution textures into the new high-resolution texture array, allowing the embryo to smoothly sharpen as bricks stream in rather than disappearing.

