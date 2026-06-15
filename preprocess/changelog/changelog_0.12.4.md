# Changelog v0.12.4

### [OPTIMIZED]
- **Diffuse Background Reduction**: Increased the bottom-end intensity threshold (`p_min`) mapped to 0 (from the 5th to the 20th percentile of the median-filtered data). This aggressively removes the diffuse autofluorescence/background noise in large 3D stacks, enhancing the sharp "neon" effect desired in Additive Blending.
