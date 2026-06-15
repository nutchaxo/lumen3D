# Changelog 0.4.3

### [FIXED]
- Fixed an issue where the viewer tools (measure, slice, grid) were missing in Compare Mode due to a mismatched payload property (data.value vs data.state) in TOGGLE_SIDEBAR message.
- Implemented a 30-second fallback timeout mechanism in the Compare Mode High-Detail loading queue to prevent the UI from permanently hanging on Loading high detail... and blocking subsequent datasets from loading.