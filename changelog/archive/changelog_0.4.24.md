# Changelog v0.4.24

## [FIXED]
- **Complete rewrite of Compare Studio compositing:** Instead of copying the CSS grid pixel layout (creating a huge canvas with mispositioned small slices), the new logic determines the grid structure (cols x rows) by analyzing panel center positions, then tiles high-res slices edge-to-edge at a uniform cell size. 2 panels side-by-side produce a 2:1 rectangle, 4 panels produce a square, etc.
- **Fixed panel settings buttons (sliders-horizontal icons):** Repositioned using the correct _imageToScreen transform that accounts for center offset and rotation. Previously used a raw formula missing the center translation, causing buttons to appear far from their actual panel.
- **Cell size cap:** Each cell is capped at 2048px to avoid massive canvases with >4 panels.
