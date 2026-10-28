# Changelog v1.73.1 (Web Platform)

## [FIXED]

- **Grain and pinholes in the fluorescence projection**: the maximum-intensity render mode started every ray at a random phase of its sample lattice (a per-pixel hash). On a noisy confocal signal the maximum then flipped from one pixel to the next, which showed as a crackling grain and black pinholes inside bright structures, everywhere in the image. The projection now anchors its lattice at an absolute distance from the camera, so neighbouring rays sample the same depth shell and the picture stays coherent. The accumulating modes (emission–absorption, structure) keep their random phase, which hides the banding of a regular lattice and averages out over the ray.
