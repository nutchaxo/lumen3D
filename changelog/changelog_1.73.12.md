## [CHANGED]
- **Axes gizmos centred on the specimen**: *Toggle Axes* and *Orientation Axes* (viewer and the admin calibration mode) now start on the centre of gravity of the stored bricks instead of the box corner. A drag pins the position; double-click / reset returns to the centre.

## [ADDED]
- **BrickLoader.getOccupancyCentroid**: normalized centroid of the non-empty bricks of the coarsest level, one pass over the occupancy bitmap, cached per mount; exposed to the scene as `VolumeViewer.getMassCenterLocal()`.
