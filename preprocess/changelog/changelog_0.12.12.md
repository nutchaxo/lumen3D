# Changelog v0.12.12

## [ADDED]
- **Noise Thresholding & morphological dilation (Halo) :**
  - Added a `BACKGROUND_THRESHOLD = 5` filter inside the chunk packer (`3-chunk_packer.py`).
  - Identified "Core" chunks exceeding maximum intensity limit across all channels.
  - Dilated core chunk coordinates with a 26-neighbor structural window (3x3x3 grid) to preserve natural fluorescent signal fade-outs and avoid sharp visual cut-offs.
  - Excluded empty chunks/pure background from packing and manifest generation to maximize VRAM and processing savings.
