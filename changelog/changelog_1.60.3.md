# Changelog v1.60.3 (Web Platform)

## [OPTIMIZED]

- **Bricks appear while their pack downloads**: a whole pack (`pack_06.bin`, `pack_08.bin`…) is now read as it arrives. Its body fills one buffer, and every brick is cut out, decoded and drawn as soon as its own bytes are in, instead of waiting for the last byte of the pack. The volume now fills in brick by brick, not in jolts of one pack at a time. Nothing more is downloaded or held in memory: the same single request per pack, the same budgets. A body without `Content-Length` grows its buffer. When `verifyHashes` is on and the manifest gives the pack a hash, the pack is still used only once it is complete and verified.
- **Bricks of a pack taken in the order they arrive**: inside a pack, the bricks are now processed in the order of their byte offsets (raster order only for a brick without one). This is the order the body streams in, so no brick waits behind one stored later. For v2 packs it is the same order as before. In v3 super-block packs, raster order used to jump across the pack.

## [ADDED]

- **Test `tests/js/test_brick_loader_progressive.mjs`**: covers bricks delivered while the pack streams, byte-offset order, a body without Content-Length, packs held back until their hash is verified, and a stalled body (bricks already delivered are kept, the rest are reported as failed and never delivered as zeros).
