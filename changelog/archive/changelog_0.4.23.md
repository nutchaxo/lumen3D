# Changelog v0.4.23

## [FIXED]
- Fixed aspect ratio distortion in Compare Slice Studio: square slices (5684x5684) were being stretched to fill the full panel rectangle (e.g. 833x1135), causing visible squishing. Now uses contain-fit logic that preserves the native aspect ratio of each slice and centers it within its panel area.
