# 1.73.8

## [FIXED]
- **Decompose export: the main picture is framed like the screen**: the figure's main view was rendered into a buffer multiplied by the display's pixel ratio; past the browser's drawing-buffer limit the buffer was clamped while the GL viewport was not, so only a magnified corner of the scene reached the figure. The export now renders at pixel ratio 1 (restored afterwards) and also respects `MAX_VIEWPORT_DIMS`.

## [ADDED]
- **Capture frame for the main picture**: while the *Channel Split* panel is open, a red frame outlines the 3D view whenever the layout has a main picture (Main + Right, Horizontal), showing exactly what is captured.
