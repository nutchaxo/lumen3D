# Changelog v0.4.22

## [FIXED]
- Fixed Slice Studio showing empty/black canvas in Compare mode. The compare-layout was hidden BEFORE reading panel bounding rectangles, causing all panels to report 0x0 dimensions. Restructured _openCompareStudio to collect all geometry data while the layout is still visible, then hide it, then compose and open the studio.
- Cleaned up diagnostic console.log statements from compare.js.
