# Changelog v1.73.2 (Web Platform)

## [CHANGED]

- **GPU memory is detected, no longer chosen**: the *GPU memory* select of Render quality is gone. The viewer names the card from the renderer string the browser exposes, looks its dedicated memory up in a table of NVIDIA, AMD and Intel Arc models (laptop parts matched first, variants sold in two sizes take the smaller) and budgets 60 % of it, always leaving 2 GiB to the browser and the system, capped at 16 GiB. A card the table does not know keeps the previous class heuristic (integrated, discrete, software), and a graphics-context loss still halves the budget.
- **GPU compression is automatic**: the *GPU compression* select is gone; every bricked volume is compressed whenever the GPU supports it, as the *Automatic* mode did.

- **Quieter resolution panel**: the Render quality panel of a format 6 dataset shows the resolution list alone, at the full width of the sidebar: the summary line, the WebP Q30 note, the colour legend and the status line under the list are gone (a warning still appears when the GPU holds a coarser level than the one chosen).

## [FIXED]

- **Stale manual settings**: a GPU memory or GPU compression value stored by an earlier version is erased at load, so it can no longer override the detection.
