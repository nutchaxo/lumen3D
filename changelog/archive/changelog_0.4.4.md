# Changelog 0.4.4

### [FIXED]
- Fixed the High Detail loading overlay in Compare mode blocking the entire view by changing its CSS from fullscreen (\inset: 0\) to a small corner progress bar widget.
- Reverted an incorrect property check (data.state) back to (data.value) for the TOGGLE_SIDEBAR event handler in iewer.js, restoring the display of the side tools when clicking the gear icon in Compare mode.
