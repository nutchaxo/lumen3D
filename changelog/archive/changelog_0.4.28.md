# Changelog 0.4.28

## [FIXED]
- Fixed a major index mapping bug in the Studio's ChannelPanel where modifications were applied to the wrong channel indices (e.g. index 4 instead of 0) when switching between datasets, causing the WebGL volume slicer to completely ignore user modifications.
- Repositioned the dataset resolution text from the top-right corner to the bottom-left corner of the slice for better visibility and layout balance in Compare mode.
