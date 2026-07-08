# Changelog 0.4.38

## [ADDED]
- **Display Defaults Support**: The channel panel now reads `metadata.display_defaults[]` for per-channel initialization (name, color, enabled, min, max, gamma, opacity, denoise_sigma). Backward-compatible when absent.
- **Midtone from Gamma**: When display_defaults provides gamma, midtone is computed via `relativeMidtone = 0.5^(1/gamma)` for precise handle positioning.
- **Denoise Sigma Slider**: Each channel now has a "Denoise σ" range slider (0–5.0, step 0.1) in the advanced panel, with full state/reset/sync support.
- **Gaussian Blur Engine**: Client-side per-channel 2D Gaussian blur via 3-pass box blur approximation (O(n) per pass). Applied per-slice during texture construction for real-time denoising.
- **display_defaults Merge**: `_mergeDatasetMetadata()` in viewer.js now includes `display_defaults` from the dataset's `metadata.json`.

## [OPTIMIZED]
- Gaussian blur uses the Ivank.net 3-pass box blur algorithm for O(n) complexity instead of naive O(n·k²) convolution.
- Blur only triggers texture rebuild when sigma change exceeds 0.05, avoiding unnecessary reloads during slider scrubbing.
