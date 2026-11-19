## [ADDED]
- **Intensity along a measurement line**: a new Graphs table, *Intensity along measurement line*, plots the signal of every channel along the distance measurements drawn in the viewer (up to 12 visible lines, trilinear sampling at the finest level that fits the channel budget, lossless voxels). X is the distance from the start point, or its fraction of the line; each line is its own series in the colour of its measurement. Two presets, *Line profile* and *Relative line profile*, and the table appears and disappears as measurements are added or hidden.
- **Time as a share of the acquisition**: the timelapse tables gain a *Time (% of acquisition)* variable (`tr`, and `divTr` for the division time of a cell), so timelapses of different lengths can be laid on one axis in Compare.
- **The Compare drawer is part of the workspace**: its open state, table, preset, X / Y and aggregation are saved in a workspace and in the `#state=` link, and come back after a reload. Compare keeps what a link says about its own plugins until they are initialised, then hands it over (`hostPlugins` in the Compare state).
- **Strict spec check in panels**: a panel refuses a question that names a variable it does not hold (`NO_VARIABLE`) instead of silently drawing something else; the Compare host rewrites the question to the variables shared by the panels first, so datasets with different channels still plot.
- **Live follow in Compare**: the host asks each panel what its table depends on (`key`) once a second while the drawer is open and redraws when a timelapse moves on; closing the drawer frees the panels' cached tables (`release`).

## [OPTIMIZED]
- **Neighbour counts**: the cells-within-radius column counts through a counting sort by frame and typed bucket lists with exact integer keys, instead of string keys.
- **Mean squared displacement**: past the operation budget the sum runs over a regular sample of the cells with every lag kept, instead of dropping the long lags; the plot says when it is sampled.

## [FIXED]
- **Wrong numbers at the edge of a binned axis**: the last bin of a Float32 axis lost the voxels sitting exactly on its upper edge; grouped bins now hold a whole number of steps, and a normalisation only divides by a positive base.
- **Co-localisation**: Manders' coefficients are the textbook ones (totals over every voxel, not only the union mask).
- **Point clouds**: subsampling is a hash of the row, not a stride, so periodic data no longer aliases.
- **Trajectories with frame gaps**: the path counts the jump over a gap (net displacement over path stays ≤ 1) while speed only comes from consecutive frames.
- **CSV and text injection**: exported cells starting with `=`, `+`, `-`, `@` are neutralised, and series names, titles and categories are escaped in the plot.
- **PNG export under the strict CSP**: the image is rebuilt from the data URL without a `fetch`, which the policy blocked.
- **Compare labels**: dataset names are shortened over every dataset of the question; "Not drawn for…" lists the panels that lacked a variable or did not answer; no "1 compared dataset" line for a single one.
- **Light theme and numbers**: the plot follows a theme switch, numbers use the language's separators, chips are real buttons with a visible focus ring and the plugin's own tokens.
- **Restoring the Compare drawer**: choices saved before the panels have described their tables used to be replaced by the first preset.
