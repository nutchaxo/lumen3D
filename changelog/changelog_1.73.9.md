# 1.73.9

## [FIXED]
- **Decompose export: main picture framed like the screen**: the main view is now rendered by the viewer's own tiled view export at the displayed canvas's aspect, instead of one resized WebGL buffer whose aspect and size could drift from the screen's. The picture matches what is shown, whatever the figure size.
