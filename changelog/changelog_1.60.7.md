# Changelog v1.60.7 (Web Platform)

## [ADDED]

- **Stabilisation switch for timelapses**: the Display panel of the viewer has a *Stabilisation* select (*Stabilised* / *Raw images*) on every timelapse whose registration applies to the volume. *Raw images* shows each frame where the microscope recorded it, with its drift and rotation. The tracking points, the trails, the surface and the tracking tools follow into the same frame of reference. The choice is kept in a saved workspace and in a shared link (`viewer.stabilized`). The option existed only on the tracking page, which was removed in v1.53.0, so it had been unreachable since then.

## [FIXED]

- **Surface button hidden on timelapses without a surface model**: the *Tracking surface* button appeared on every tracked timelapse. Most of them have no `model.glb` (`tracking.surfacePath` is empty), so a click tried to download a missing file and the button switched itself off again without a word. A plugin can now require `tracking-surface`, which a dataset satisfies only when its tracking block names a surface model; the *Tracking surface* plugin (1.0.3) requires it.
- **Imported datasets no longer keep the admin preview address of their bricks**: when an operator edited a dataset while it was still uploading, the editor's copy, whose volume sources point at the admin-only `api/upload.php?action=blob` proxy, was saved back into `metadata.json` and survived publication. Both servers now save those sources as their `DATA_WEB/<type>/<folder>` location, and the start-up repair that already fixes a dataset's identity rewrites the ones already published (Python at every start, PHP on the next catalog request).
