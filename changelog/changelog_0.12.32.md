# Changelog 0.12.32 (Plateforme Web)

## [FIXED]
- **Channel Previews/Done Button in Decompose by Channel Mode:**
  - Resolved the issue where starting an edit on a decomposition view caused all other channel previews in the sidebar to go black.
  - Implemented dynamic check of `DecompositionPanel.isOpen()` inside `_recompileShaderForActiveChannels()` in `volume-viewer.js` to ensure the fragment shader keeps compilation blocks (`ENABLE_CHANNEL_X = 1`) active for all channels when in decompose mode. This ensures the GPU program can sample any channel for any preview canvas.
  - Resolved the issue where clicking "Done" failed to restore the multi-channel state in the main viewer by changing the notify option to `notify: true` when calling `ChannelPanel.setState` in `_stopEditing()`. This properly triggers the global update listeners to update WebGL uniforms and recompile the shader.
