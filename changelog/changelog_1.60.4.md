# Changelog v1.60.4 (Web Platform)

## [ADDED]

- **Keep the previous version of a dataset**: a new *Keep the previous version* box in the Data updates tab (unticked by default) makes a 3 → 4 update keep the v2 bricks it replaces as `bricks.previous/` instead of deleting them, so the same dataset can be seen before and after. It costs as much room again as the bricks of each dataset; the tab lists the versions kept with their size, a link that opens one in the viewer, and a *Delete* button (`drop_previous`, Python and PHP). The status row reports it as `previous: {schema, bytes}`.
- **Show the previous version in the viewer**: `viewer.html?bricks=previous` reads every brick from `bricks.previous/`; the header says so, and a dataset without one opens on its current version with a notice. The plugin context gains `ctx.dataset.brickTree()`, `hasPreviousBricks()` and `openBrickTree(tree)`, which reloads the page on the other version and restores the same view (camera, channels, tools) through `sessionStorage`, without the shared-view question.
- **Version choice in Chunk debug (1.2.0)**: while the overlay is on, a small panel shows the brick format on screen (v2 64³ or v3 66³) and, when the dataset kept its previous version, a *Version* list (current / previous) that switches between them. Region-of-interest detail stays in the sidebar's quality section.
