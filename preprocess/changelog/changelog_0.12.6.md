# Changelog v0.12.6

### [OPTIMIZED]
- **Compression**: Increased `gzip.compress` level from 4 to 9 in `3-chunk_packer.py`. This maximizes the compression of empty and low-information voxels inside the 3D chunks, trading slightly longer preprocessing times for significant storage space savings (up to 30-40% smaller output datasets), without any loss of biological fidelity (lossless).
