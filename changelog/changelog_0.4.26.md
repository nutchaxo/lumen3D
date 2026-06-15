# Changelog 0.4.26

## [FIXED]
- Fixed biological crop logic to crop out unused/transparent border space in canvas slices, properly making images take up full available canvas space.
- Corrected pixelSizeX and pixelSizeY calculations in `viewer.js` to rely on the source render resolution rather than the cropped dimensions.
- Fixed aspect ratio squishing bug in `compare.js` by adapting rendering scale dynamically to bounds while preserving the image ratio.
- Fixed small, hard-to-read dataset labels in `compare.js` Studio grid, calculating them dynamically based on space. Also truncated long names adaptively to fit in the panel space.
- Fixed "ChannelPanel not loaded" in Compare Studio UI by properly loading `channel-panel.js` in `compare.html`.
- Updated `studio-editor.js` logic to recompose sliced canvases using the `VolumeSlicer` belonging to the specific origin `iframe` to maintain proper dataset references.
