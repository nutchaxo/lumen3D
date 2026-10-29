## [FIXED]
- **Grid projection drawn over the specimen**: the projection of the volume on the grid walls was sorted with the other transparent objects by distance, so a wall nearer the camera than the volume was painted over the embryo, in all three directions. The projections are now drawn before the volume, so the specimen always stays in front of them.
