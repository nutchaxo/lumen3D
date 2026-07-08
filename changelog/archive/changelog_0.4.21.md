# Changelog v0.4.21

## [FIXED]
- **Critical:** Fixed cross-iframe access to ViewerApp, VolumeViewer, and VolumeSlicer from compare.js. These modules were declared with const (IIFE pattern), which does NOT create properties on window. The parent frame (compare.js) accessed them via iframe.contentWindow.VolumeViewer which always returned undefined. Added explicit window.X = X assignments after each IIFE to expose them.
- This was the root cause of the Slice Studio black squares bug: compare.js could never reach any viewer module inside the iframes, so getCurrentSliceResult() was never called and sliceResults was always empty.
