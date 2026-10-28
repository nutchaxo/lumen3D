# Changelog v1.72.0 (Web Platform)

## [CHANGED]

- **Region-of-interest detail removed**: zooming no longer streams finer bricks into a second atlas. It was slow, and the embryo is normally looked at whole, so the quality chosen in the list is the quality shown. The *Zoom detail* select and its status line are gone from the Render quality panel, and so are the `ROI_DETAIL` paths of the ray-marcher, the detail role of the atlas manager and the scheduling code behind them (`SVRRoi`).
- **No refinement at rest on a format-5 tree**: the *Lossless once the view rests* option, which loaded the bricks in view again from the lossless column when the camera stopped, depended on that streaming and is removed with it. A format-5 dataset shows the column chosen in the quality list, and a format-6 dataset (the current format) never had the option. Exports and measurements still read the lossless data.
- **Atlas manager**: the residency helpers only the detail streaming used (`touch`, `residentKeys`, `residentCount`, `evict`) are removed.
- **Tests**: `tests/js/test_v3_render_roi.mjs` becomes `tests/js/test_v3_render.mjs` (quality presets, bordered atlas, dense texture, live manifests) without the region-of-interest scenarios; `tests/js/test_v3_page_detail_status.mjs` is deleted; the shader permutation test now covers the split RG8 + R8 atlas instead of the detail defines.

## [OPTIMIZED]

- **Shader**: the ray-marcher no longer carries the detail page table, four detail atlas samplers and the second lookup in the march of every sample. A volume binds at most nine samplers (eight pages and the page table) instead of fourteen.
