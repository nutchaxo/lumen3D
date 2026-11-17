# ImageJ 1.54p golden fixtures (wave 2)

Headless Java driver that runs the real ImageJ 1.54p classes (no GUI, no `IJ.run`: the
menu path needs AWT menus, so each command's plugin class is driven the way
`PlugInFilterRunner` drives it) and writes JSON to `tests/fixtures/ij-wave2/<pkg>/<case>.json`.

Local only: not shipped (`tools/build_release.py` copies an allowlist of root dirs that
excludes `tools/` and `tests/`), never run in CI. The jar stays outside the repo.

```
tools/ij_fixtures/run.sh <path/to/ij-1.54p.jar> [pkg ...]     # pkg: bg flt seg multi geom roi
```

`run.sh` compiles the `.java` files into a temp dir (outside the repo) and runs `Main`.
Output is byte-reproducible (seeded `java.util.Random`, no clocks): two runs give identical files.
Setup: `Prefs.blackBackground=true` (binary masks are 255 on black), `Prefs.padEdges=false`.

## Fixture schema

```
{ "imagej": "1.54p", "case": "<file name>", "op": "<registry op>", "call": "<Java call chain used>",
  "params": { ... as the JS op takes them },
  "input": IMAGE, ["input2": IMAGE,] ["roi": ROI,]
  "output": IMAGE | "outputs": { name: IMAGE } | "result": any,
  ["outputsOp": "findMaximaImage"] }
IMAGE = { "width", "height", "bitDepth": 8|16|32, "data": ARRAY }
ARRAY = number[] (only when <= 256 values; float NaN -> null)
      | { "b64": base64, "dtype": "u8"|"u16"|"f32", "length": n }   little-endian typed bytes
        (float images containing +-Infinity are always b64; f32 NaN survives in b64)
ROI   = { "type":"rect"|"oval", x,y,w,h } | { "type":"polygon", "pts":[x0,y0,...], "traced"?: true }
        + "mask": { x,y,w,h, data: ARRAY/b64 u8 of 0/1 } for oval/polygon (ImageJ's own rasterisation)
```
Decoding helper (copy into a test; Node 20, no dependencies):

```js
function decodeData(d) {                      // -> Array<number> (NaN for null) or typed array
  if (Array.isArray(d)) return Float64Array.from(d, (v) => (v === null ? NaN : v));   // plain floats are shortest-repr of a float32: Math.fround() them for 32-bit images
  const b = Buffer.from(d.b64, 'base64');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);             // aligned copy
  return d.dtype === 'u8' ? new Uint8Array(ab) : d.dtype === 'u16' ? new Uint16Array(ab) : new Float32Array(ab);
}
const num = (v) => (v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v === null ? NaN : v);   // scalars in `result`
```
(`Uint16Array`/`Float32Array` are little-endian on every Node target.)

Non-finite doubles in `result`: NaN -> `null`, +-Infinity -> the strings `"Infinity"` / `"-Infinity"`.
Calls that threw record `"result": {"error": ...}` (none do at the moment).

Image values: 8-bit 0..255; 16-bit 0..60000 (blobs) or 0..65535 (noise); 32-bit about -100..400.
`tex` images = seeded gaussian blobs on a sloped background plus noise. Inputs hold the traps:
plateaus/ties/edge maxima (Find Maxima), touching disks + hole + speck (EDM/Watershed), thin lines,
NaN blocks (Remove NaNs), zeros and extremes (Blitter), non-square and odd sizes.

## Packages and result shapes

* `bg` (P1): `subtractBackground` {radius, light, createBackground, sliding, disableSmoothing,
  correctCorners} -> `output`. `saturatedRange` -> `result {displayMin, displayMax}`.
  `enhanceNormalize` {saturated, normalize, entireImage} -> `output` + `displayRange {min,max}`
  (ImageJ's `run()` then sets 0..max). `enhanceEqualize` {classic} -> `output` (8/16-bit only;
  ImageJ refuses 32-bit). With a selection: stats from the selection, `normalize` + not
  `entireImage` touches only the selection (float normalisation ignores the mask: ImageJ).
* `flt` (P2): `filter3x3` {type smooth|sharpen|edges}; `unsharpMask` {sigma, weight};
  `convolve` {kernel, kw, kh, normalize}; `rankExtra` {type variance|outliersBright|outliersDark,
  radius, threshold}; `rank` (despeckle = median r 1); `topHat` {radius, light, dontSubtract};
  `removeNaNs` {radius}; `math2` {op, value?, displayMin, displayMax, displayRangeExplicit}
  (`value` = gamma, or the integer of the binary string for and/or/xor; the display range is the
  ShortProcessor min/max the op is relative to); `nanBackground` {lower, upper}.
* `seg` (P3): `edm`, `ultimatePoints`, `watershed`, `voronoi` {output overwrite|float};
  `skeletonize`; `binary` {op outline}. `findMaxima` {prominence, strict, excludeEdges, light,
  aboveLower:{lower}|null}: `result {count, points:[x0,y0,...]}` in ImageJ's sorted order, and
  `outputs {single, tolerance, segmented}` (0/255 images; `findMaximaImage`). With a selection
  `single`/`tolerance` are limited to it; `segmented` is computed without it (ImageJ deletes
  the roi for that output). 16-bit images are the 8-bit levels x 200, 32-bit levels x 0.01 + 1;
  prominence is given in the type's own units.
* `multi` (P4): `imageCalculator` {op, create, float32} with `input` (image 1) and `input2`;
  `splitChannels` / `mergeChannels` (`result.names`, merged LUT colours at index 255).
  Divide by zero values come from the Blitters (also recorded as `divideByZeroValueFloat`).
* `geom` (P5): `rotate` / `rotateEnlarge` {angle, interpolation none|bilinear|bicubic}; with `roi`
  the selection rectangle (and mask) is rotated in place. `scaleInPlace` {xscale, yscale,
  interpolation}; `scaleNew` {xscale, yscale, interpolation, averageWhenDownsizing, width, height};
  `resize` {width, height, interpolation, averageWhenDownsizing}; `canvasSize` {width, height,
  position, xOffset, yOffset} (zero fill); `translate` {dx, dy, interpolation}; `bin`
  {xshrink, yshrink, method average|median|min|max|sum}.
* `roi` (P6): `measure` -> `result.columns` (ImageJ result-table headings: Area Mean StdDev Mode Min
  Max X Y XM YM Perim. BX BY Width Height Major Minor Angle Circ. Feret IntDen Median Skew Kurt
  %Area RawIntDen FeretX FeretY FeretAngle MinFeret AR Round Solidity), pixels or calibrated
  (`params.calibration`); `measureLine` (Length, Angle); `wand` {x, y, tolerance, connectivity 4|8}
  -> `result.pts` outline in ImageJ order + mask; `enlargeRoi` {n} -> `result.menu`
  (`RoiEnlarger.enlarge255`, what the command runs) and `result.exact` (EDM float path);
  `createMask` -> `output` (255 inside); `createSelection` (threshold) -> `result.polygons` + mask;
  `convexHull` -> `result.pts`; `fitEllipse` -> major/minor/angle + the ellipse polygon + mask;
  `profile` {roi line|polyline, width} -> `result.profile`; `angle` {pts} -> `result.angle`.
  Roi results: `{class, bounds, type, mask?, polygons:[[x,y,...]...]}` (a hole is its own sub-polygon).

Also `measure` with a threshold (`params.threshold`, `params.limit`: %Area counts thresholded pixels,
Limit to threshold restricts every statistic) and `measurePoints` (`result.rows`, one row per point of a
multi-point selection) for P6.

P7 (Coloc 2) has no ImageJ core reference: no fixtures.

## ImageJ behaviours recorded here that a port must reproduce (found while auditing the driver)

* `subtractBackground` ignores a selection (flags carry no `SUPPORTS_MASKING`): `rb_*_roi_*` fixtures
  show the whole image processed.
* Find Maxima *Light background* inverts a duplicate with `ip.invert()`; with the default
  `Prefs.fullRange16bitInversions=false` a 16/32-bit invert is `v' = (min+max) - v` over the DATA min/max
  of the image (`resetMinAndMax()` first), not over 0..65535. The fixture inputs have their data range as display range.
* Fit-ellipse statistics (`Major`, `Minor`, hence `AR`=NaN and `Round`=Infinity in a table) are 0 when the pixels
  are non-square (`|pw-ph|/pw >= 0.01`, `ImageStatistics.fitEllipse`): see `measure_*_cal0p5x0p3`.
* 16-bit `math2` ops are relative to the ShortProcessor min/max the op sees: `params.displayMin/displayMax`
  carry them (`resetMinAndMax()` of the data unless `displayRangeExplicit`).
* Image Calculator integer divide by zero gives the type max (8-bit 255, 16-bit 65535), float +Infinity
  (`FloatBlitter.divideByZeroValue`, recorded per fixture); different sizes keep the smaller rectangle.
* `translate` by a non-integer offset with interpolation `none` rounds the offset (`translate_0p4_0p4_none_*` = identity).
* `Find Maxima` strict mode with a prominence larger than the whole range finds nothing
  (`fm_lowcontrast_strict_*`: `count` 0); loose mode accepts the global maximum.

## Not reproduced / caveats

* `IJ.run` is unusable headless (AWT menus), so GenericDialog defaults are not exercised; the
  dialog-derived state is replicated by hand where it changes the result (documented in each
  `call`: e.g. Enhance Contrast `updateSelectionOnly`, `classicEqualization`, the Rotate
  *Enlarge* canvas computation).
* `correctCorners=false` for the sliding paraboloid is only reachable through the public method
  (the menu always passes true).
* The Wand *Legacy* mode, RGB images, stacks, Coloc 2 and RoiManager Multi Measure are out of scope.
* EDM output types BYTE/SHORT are not recorded (overwrite and float only).
