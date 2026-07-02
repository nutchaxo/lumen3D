# Changelog 0.12.29 (Plateforme Web)

## [FIXED]
- **Decompose by Channel View Rendering:**
  - Gated the channel intensity computation segments in `volume-viewer.js` fragment shader inside the `ENABLE_CHANNEL_X` preprocessor blocks with runtime uniform activation state checks (`en0 == 1`, `en1 == 1`, etc.).
  - This prevents disabled channels from being rendered in decomposition previews where specific channels are supposed to be soloed out, fixing the bug where all channels were shown on every preview panel.
