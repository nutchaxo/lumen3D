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
* EDM output types BYTE/SHORT are not recorded in wave 2 (overwrite and float only); wave 3 records all four in `thr/edm_outputs_*.json`.

---

# Wave 3 (`tests/fixtures/ij-wave3`)

Same schema as above. Three drivers, all local only (never shipped, never in CI):

```
tools/ij_fixtures/run3.sh <ij-1.54p.jar> [pkg ...]       # IJ1 goldens: thr enh fft sel io ov ana edit fiji lib
tools/ij_fixtures/fiji/run_fiji.sh DialogCapture    tests/fixtures/ij-wave3/fiji-dialogs.json     # GenericDialog / Swing structure of the Fiji commands
tools/ij_fixtures/fiji/run_fiji.sh ModuleInfoCapture <out.json>                                   # SciJava ModuleInfo (Frangi); merged into fiji-dialogs.json
tools/ij_fixtures/fiji/run_fiji.sh CompositeCapture <out.json>                                    # dialogs that change on a composite / 16-bit image; merged into fiji-dialogs.json (`variants`)
tools/ij_fixtures/fiji/run_fiji.sh FijiRefs tests/fixtures/ij-wave3 [cmd ...]                     # reference outputs of the Fiji plugins (GPL: RUN only, never read)
tools/ij_fixtures/fiji/run_fiji.sh RepeatCapture tests/fixtures/ij-wave3/repeat-command.json
tools/ij_fixtures/fiji/run_fiji.sh JamaTies <in.json> <out.json>                             # `enh/jama_ties.json`: Jama eigenvalue bits of the tied Frangi Hessians (the cases of the stored file are a valid input)
```

`run3.sh` starts a GUI-less `ij.ImageJ` instance (menus for `IJ.run`, `java.awt` dialogs in macro mode: it needs a desktop
session), runs the whole job on one thread named `Run$_fixtures` (ImageJ reads macro options only on such threads) and
points `user.home` to a temp dir so the operator's `IJ_Prefs` never leaks in. `Prefs.blackBackground=true`,
`padEdges=false`. The Fiji drivers use the Fiji install (`FIJI`, default `D:/APT/3A/BIOIMAGING/Fiji`) and its bundled Java;
`FIJI_TMP` picks the class directory. The Fiji drivers also run with a clean `user.home` (no operator `IJ_Prefs`);
`fiji-dialogs.json` records `prefsBlackBackground`, and `fiji-dialogs.black-false.json` is the same capture with
`Prefs.blackBackground=false` (identical dialogs: the *White objects on black background* default is Fiji's own).
`DialogCapture` writes the whole `fiji-dialogs.json` (it calls `CompositeCapture` and `ModuleInfoCapture` and generates `notes`);
GenericDialog text fields are typed `numeric` / `string`.

Reproducibility. The ImageJ goldens (`run3.sh`) are byte-identical between runs. Fiji references are too, except these fields:
* `fiji/coloc2/pairs.json`: the p-value, the hash-based `Coloc_Job_Name` and `Mask ID Used`, "Costes Shuffled Mean" / "Std.D.",
  and in some cases "Ratio of rand. Pearsons...". The Log is printed at 2 (Pearson), 4 (Kendall), 8 (Spearman) and 3 (Manders)
  decimals and is parsed into `parsed`; the numbers to test are the exact ones in `pairs_exact.json` (numpy / scipy on the same
  inputs, Fiji's thresholds; rebuild with `fiji/coloc_exact.py`), checked against the Log at its printed precision.
* `fiji/roiset/roiset_zip.json`: `zipB64` holds the run's date and time in the zip entries (the `entries` summary does not).
* Text fixtures (`io/text_encoder.json`, `io/xy_writer.json`, `fiji/cellcounter/markers_xml.json`) are normalised to LF (a `lineEnding` note says so; the `io` ones also record
  `capturedLineSeparator`); ImageJ emits `System.lineSeparator()`, the port emits LF.

Result shapes that differ from wave 2: many files hold `"cases": [ { "params", "input"?, "output"|"result" } ]` with one shared
`input`; `roi-file` entries (`io/roi_files.json`, `io/roiset_zip.json`, `fiji/roiset/roiset_zip.json`) carry the `.roi` / zip
bytes as base64 (`b64`, `zipDeflatedB64`, `zipStoredB64`, `zipB64`) next to the decoded selection (`roiFull`: class, type,
float bounds, float polygon, mask, stroke width, spline flag, name). `edit/draw.json` stores `changed: [[pixelIndex, value]]`
against a constant background. Stacks are arrays of IMAGE objects.

Packages: `thr` AutoThresholder (17 methods x 20 histograms, 16-bit trimming), Binary options matrix, foreground rule, Binary
Median, threshold mask · `enh` seeded noise (8/16/32-bit, ROI, one stream across channels), Salt and Pepper · `fft` FHT forward /
power spectrum / raw PS, inverse with pass and filter masks, Bandpass (+ the filter arrays), Swap Quadrants · `sel` Fit Spline /
Circle / Rectangle, Interpolate, Scale, Rotate, Translate, Make Band, Line to Area, Area to Line, Straighten · `io` RoiEncoder
bytes, RoiSet zips, `decode_ours` (RoiDecoder over `io/ours/*.roi`: run `run3.sh <jar> io` AGAIN after P-io drops files there),
TextEncoder, TextReader, XYWriter, XYCoordinates · `ov` Grid shapes (M/L/C segments), Scale Bar rectangles and auto width ·
`ana` ParticleAnalyzer outputs / tables, calibrated sizes, Invert Y, Histogram 16/32-bit, ProfilePlot · `edit` paste Blitter
modes, Filler.draw, NewImage, conversions, full-range invert, Duplicator channels, Montage, built-in and file LUTs · `fiji` (IJ1)
Fractal Box Count, Curve Fitting (every built-in function, `Minimizer.setRandomSeed(1)`, one thread) · `lib` ZProjector.

Fiji references live under `fiji/<cmd>/`: `autothreshold`, `autolocalthreshold`, `clahe`, `tubeness`, `frangi`, `directionality`,
`skeleton`, `localthickness`, `coloc2`, `cellcounter` (Fiji-written marker XML), `roiset` (RoiManager zip written inside Fiji).
Every case stores the options string passed to `IJ.run` and `describe()` = `{ self (the in-place image), created[] (new images),
table (Results), log }`.

Behaviours recorded here that a port must reproduce (found while building the fixtures):

* `TextReader` always returns a 32-bit float image (no 8/16-bit auto type); an all-NaN first row is dropped as a header.
* 16-bit `ZProjector` Average and 8/16-bit Sum/SD return 32-bit; Max/Min/Median keep the stack type; 16-bit Average is 16-bit.
* A `ScaleBar` unit "um" is shown as "µm"; the label width is Java font metrics, so only rectangles that do not depend on it are comparable.
* `LutLoader.openLut` accepts NIH Image files only when their length exceeds 768 bytes (a 16-colour NIH LUT of 80 bytes is rejected).
* Fiji Auto Threshold on a 16-bit image (`fiji/autothreshold/blobs16_*.json`, run with `show`: the level is parsed from the Log into
  `logLevels`, in 16-bit units; `afterMin/MaxThreshold` = the image's threshold after the command, -808080 = none): without
  "setthreshold" it makes an 8-bit binary image (2 values); WITH "setthreshold" it makes an 8-bit image holding 228 distinct grey
  values (not binary); Huang on 16-bit does not finish in 15 s and leaves the image 16-bit unchanged. The same 16-bit inputs run
  through ImageJ's own trimmed 16-bit histogram thresholds in `thr/threshold16_fiji_blobs16_*.json`: compare the levels, do not assume they match.
* Fiji Auto Threshold's dialog default method is "Try all", its list has no IJ_IsoData and calls MinError "MinError(I)".
* Process › Repeat Command re-shows the dialog with the last values (`repeat-command.json`); Undo and Close are not remembered
  (both are tested there: after Undo, Repeat re-runs Invert; after closing an image, Repeat re-runs Invert on the next one).
* Binary Options "EDM output" (Overwrite / 8-bit / 16-bit / 32-bit) for Distance Map, Ultimate Points and Voronoi: `thr/edm_outputs_*.json`.

---

# Stacks (`tests/fixtures/ij-stacks`)

Golden fixtures for the real image stacks / hyperstacks / 24-bit RGB work (`DOCS/studio-advanced/stacks/PLAN.md`). Local only, never CI.

```
tools/ij_fixtures/run4.sh <ij-1.54p.jar> [group ...]
  group: dialogs zproj reslice substack reduce reverse concat hyper montage zprofile stats labels slices rgb convert tiff stackproc
```

Driver `W4Stk.java` (+ `W4Dlg`, `W4Zp`, `W4Ops`, `W4Hyp`, `W4Ana`, `W4Rgb`, `W4Conv`, `W4Tiff`, `W4Sp`; reuses `Fx` / `J` / `Gen`). Unlike waves 2 and 3, almost every case goes through
`IJ.run(imp, command, options)` on a GUI-less `ij.ImageJ`, in batch mode (images stay hidden), the job on one thread named `Run$_fixtures`, a clean `user.home`, `blackBackground=true`, `padEdges=false`.
Each case records the command AND the options string, so a port can check the macro option keys too. The `dialogs` group runs the commands in GUI mode with no options and walks the visible AWT
dialog (public API only, the technique of `fiji/DialogCapture.java`; the jar alone, no Fiji). Output is byte-reproducible (full runs diff clean: seeded inputs, no clocks; the free-memory figure of
the Reslice dialog is normalised, the Channels tool window that opens beside composites is ignored). A failing case writes `"error"` and the run goes on (the last run had none).
477 files, about 8.4 MB. Do not run `IJ.run` with an EMPTY options string on a command that has a dialog: the dialog opens (use a blank, e.g. `" "`).

## Schema

```
STACK = { "title", "dims": {"c","z","t"}, "hyperstack": bool, ["composite": true, "mode": "composite"|"color"|"grayscale"],
          "width", "height", "bitDepth": 8|16|24|32, "currentSlice": n (1-based), "position": {"c","z","t"} (1-based),
          "planes": [ARRAY in ImageJ stack order (n = t*nC*nZ + z*nC + c)], ["labels": [string|null per plane]],
          "calibration": {pixelWidth,pixelHeight,pixelDepth,unit,xOrigin,yOrigin,zOrigin,frameInterval,timeUnit,fps,loop},
          "displayRanges": [[min,max] per channel (one entry for a non-composite image, [0,255] for RGB)],
          "luts": ["grays" | "inverting" | {"mapSize","rgb": base64 of 768 bytes = R[256],G[256],B[256]}] per channel (absent for RGB) }
RGB plane = { "rgb": true, "b64", "dtype": "u8", "length": 3*w*h }   interleaved R,G,B per pixel (ColorProcessor int pixels, alpha dropped)
other planes = the ARRAY of the section above (number[] when <= 256 values, else {b64,dtype,length}). An RGB stack's dims.c is 1 (its 3 colours are not channels).
```

A case file is `{imagej, case, op, command, options?, input: STACK, [input2 | inputs[] + current], [roi], self?, created[], table?, log?, dialogs?, thrown?}` or, when one input runs through several
option strings (`input` stored once), `"cases": [ { options, self?, created[], table?, log?, dialogs?, thrown?, others? } ]`.
`self` = the image the command ran on, afterwards (left out when unchanged, `null` when the command closed it); `created` = images that appeared (plots are `{title, plot:true}`); `others` = the other
open inputs afterwards (`"unchanged"`, a STACK, or `null` when closed); `table` = Results `{headings, rows}` (Label as text); `dialogs` = the message / GenericDialog windows ImageJ raised while the command
ran with options (an error: `thrown: "RuntimeException: Macro canceled"` accompanies it, `IJ.error` aborts a macro).

Group specifics: `zprofile` `plots[{title,x,y,limits}]` (the Plot's own arrays, not its picture); `labels` `changedSlices` (slices that got pixels; the pixels are font dependent and not compared) and
`overlay[{position,c,z,t,text,x,y}]` (the texts of `use` = overlay); `stats` `setMeasurements`; `tiff` = `{call, input, tiff:{b64,length}, byteOrder, ifdCount, ifds (tag,type,count,value of the first 3
IFDs), description, fileInfo, reopened: STACK, reopenedClass}` + `tiff/description_strings.json`; `rgb` `weighted` = Conversions "Weighted RGB conversions"; `dialogs/*.json` = `{command, menuClass,
menuPath, image (before the run), others, steps:[{class,title,modal,components:[{t,label,key,keyRaw,value|items|selected|state}]}]}` with t = label message numeric string checkbox radio choice
button; `key` = the macro option key (first word of the label, lower case); `noDialog: true` = the command asks nothing; `windows` = other frames it opened.

## ImageJ 1.54p behaviours recorded here that a port must reproduce

* **Process all N images?** is a `YesNoCancelDialog`, title `Process Stack?`, text `Process all N images? There is\nno Undo if you select "Yes".` (Yes / No / Cancel). Histogram asks
  `Include all N images?` (title `Histogram`); Analyze Particles and Image Calculator ask `Process all N images?` with the title `Process Stack?` and WITHOUT the Undo sentence. In macro mode
  `IJ.setupDialog` reads the word `stack` as Yes and its absence as No (current slice only); `slice` in the options forces No on a composite. A composite in COMPOSITE mode is processed whole with no
  question (`dialogs/process_all_invert_hyper_composite`: noDialog); COLOR / GRAYSCALE composites ask.
* Z Project output types: 8-bit Average / Max / Min / Median stay 8-bit, Sum and SD are 32-bit; 16-bit Average / Max / Min stay 16-bit, **Sum, SD and Median are 32-bit** (through `IJ.run`); RGB gives RGB.
  A hyperstack projection keeps the channels (composite, display ranges, LUTs); `all` is offered only with nT > 1; without it only the current frame is projected; start/stop are clamped.
* Make Montage on a hyperstack with c > 1 and (z > 1 or t > 1) is refused: `5D hyperstacks are not supported`. A one-slice composite becomes a 24-bit RGB montage (composite and color mode alike).
  Only the `label` option draws text (font dependent, not in these fixtures).
* Reslice keeps c and t of a hyperstack. With `avoid` the output spacing is the z spacing whatever `output` says; a calibrated stack with `output=0.5` gets z * pixelDepth / output slices.
  A line selection gives `slice_count` output slices, a rectangle ignores it.
* Reduce... works IN PLACE (`self` changes, nothing is created); on a hyperstack it reduces frames unless `reduce` (Reduce in Z-Dimension) is set. Make Substack: `delete` removes the slices from the
  original, `do` ("Do not create substack") did NOT suppress the substack in these runs (`substack_range`); a bad list is a MessageDialog `Invalid input string`. Make Subset and Make Substack are one
  class (`SubstackMaker`); on a hyperstack it also moves the source's channel position (`self` differs by `position` only).
* Reverse is refused on a hyperstack (`This command does not currently work with hyperstacks.`, title `Flip Z`).
* Stack to Hyperstack: orders xyczt (default), xyctz, xyzct, xyztc, xytcz, xytzc; c x z x t must equal the slice count (`channels x slices x frames <> stack size`). With c > 1 the result is a NEW
  CompositeImage in the chosen display mode (`created`; the original keeps its stack, with new dims); 12 channels come out in `color` mode. Hyperstack to Stack of a composite makes a plain stack (labels kept).
* New Hyperstack: `display` is ignored for 1 channel; an RGB hyperstack has dims.c = 3 with 24-bit planes; labels `c1z1t1`. Reduce Dimensionality: a CHECKED dimension is kept, an unchecked one is taken at
  the current position; `keep` (Keep source) is off by default and without it the source is replaced.
* **RGB Stack / HSB Stack / HSB (32-bit)** convert IN PLACE to a plain 3-slice stack (dims.c = 3, not hyperstack, not composite) with labels `Red Green Blue` / `Hue Saturation Brightness`; RGB Color brings
  such a stack back (`convert_rgb_stack_roundtrip`). RGB Stack of an RGB *stack* creates a composite hyperstack (c3 x z) and empties the original. **Lab Stack** (`ColorSpaceConverter.RGBToLab`,
  `convert/lab_stack_converter_api`) is a **CompositeImage**: 32-bit, 3 channels, grayscale mode, labels `L* a* b*`; the command opens it as a new window and closes the original (so in batch mode `self`
  is unchanged and `created` empty), and a stack gets the `Supported Conversions` message.
* RGB Color from a composite: dialog `Convert to RGB` (Slices (z), Frames (t), Keep source). Without `keep` the image is converted IN PLACE (`self` becomes 24-bit); with `keep` a new `<title>-1`
  (hyperstack) or `<title> (RGB)` (single plane) image is created. A single-channel 8/16/32-bit image or stack is converted in place through its LUT and display range (one range for the whole stack).
* 8-bit / 16-bit / 32-bit from RGB: unweighted = (R+G+B)/3, weighted (Conversions...) = 0.299 R + 0.587 G + 0.114 B (`rgb/to_*`; `to_8bit_weighting_factors`). The Conversions command needs a non-empty options string.
* 8-bit Color (MedianCut): an 8-bit image with its own LUT of `number` colours (300 gives 256, 1 gives 2).
* Make Composite on an RGB image gives an 8-bit 3-channel composite (`display=` is not read); on a 2..8 slice stack it makes that many channels (composite mode).
* Split Channels: RGB gives `title (red)` / `(green)` / `(blue)` 8-bit images (original closed); a composite gives `C1-title`, `C2-title`... keeping z and t. Merge Channels without `create` makes a 24-bit
  image titled `RGB`, with `create` a `Composite`; sources are closed unless `keep`; c1..c3 = red green blue, c4 gray, c5 cyan, c6 magenta, c7 yellow; a missing key is `*None*`.
* Refused on RGB (texts in `rgb/refused_on_rgb.json`): Skeletonize / Fill Holes / Erode (`requires an image of type 8-bit grayscale ...`), Distance Map / Watershed (`8-bit binary image (0 and 255) required.`),
  Analyze Particles (`RGB images must be thresholded using Image>Adjust>Color Threshold.`), Invert LUT (`RGB images do not use LUTs`), Threshold.
* ColorProcessor `setMinAndMax` rewrites the pixels (`rgb/rgb_set_min_max`); RGB statistics and histogram are of the luminance (weighted or not per Conversions).
* `Statistics` (Stack Statistics) writes its own Results columns `Voxels, [Volume(unit^3)], %Volume, Mean, StdDev, Min, Max, Mode, Median` whatever Set Measurements says (Median empty for 32-bit).
  Measure Stack... writes one row per slice with `Slice` (a hyperstack first asks `Measure Hyperstack`: Channels / Slices / Frames checkboxes). Stack position adds `Slice` (plain stack), `Ch Slice Frame`
  (hyperstack; `Slice Frame` without channels); Display label gives `title:label`, or `title:n` for an unlabelled stack.
* Plot Z-axis Profile: x = slice number, `(i-1) * pixelDepth` for a calibrated stack, `(i-1) * frameInterval` for a calibrated time profile; a hyperstack with z > 1 and t > 1 asks `Profile` =
  `time` | `z-axis` (key `profile`, default time). A single image: `This command requires a stack.`
* Label...: the overlay variant (`use`) adds one TextRoi per slice (text + trailing newline); `format=Label` on an unlabelled stack prints `null slice label (n)`.
* Add Slice on a hyperstack asks `Add` = channel | slice | frame and `Prepend`; Delete Slice asks `Delete current`; Set Slice asks Channel / Slice / Frame; Images to Stack with different sizes asks the
  `method` (`Copy (center)`, `Copy (top-left)`, `Scale (smallest)`, `Scale (largest)`); Stack to Images names images by slice label, else `title-0001`.
* FileSaver (TIFF): **one IFD per plane** (hyperstacks too); description `ImageJ=1.54p\nimages=N\nchannels=..\nslices=..\nframes=..\nhyperstack=true\nmode=composite\nunit=micron\nfinterval=1.5\nspacing=2.0\nfps=5\nloop=false\nmin=..\nmax=..\n`
  (null-terminated in the file); a unit `um` is stored as the literal text `µm`; channel ranges / LUTs and slice labels are in the IJMetadata tags (`ifds`).
* **Driver globals:** `W4Stk.kase()` resets, BEFORE every case, what a case may have changed (Conversions: weighted off + scale on, Set Measurements: `W4Ana.DEFAULT`, Prefs.blackBackground = true,
  the Results table), so a case that failed half-way can no longer leak into the next regeneration. File > New > Image has the fill choices `White, Black, Ramp, Noise`: `slices/new_image_invalid_fill`
  records ImageJ's answer to a word that is none of them (a MessageDialog `"Random" is not a valid choice for "fill"`, then `Macro canceled`; the 32x24 black 8-bit `Untitled` in its `created` was verified to be ImageJ's own output, not a leftover: every case starts with no image open); `slices/new_image_stack` holds only successful fills.
* Dialog keys: a checkbox label with a leading blank (`" Preview"`, `" Use overlay"`) gives key `""` by `Macro.trimKey` (`keyRaw`); `key` is computed on the trimmed label.
* Inputs are small on purpose: plain images 30x18, hyperstacks 24x16 (2-3 channels, 2-4 slices, 1-2 frames), `touchingDisks` 48x40 for particles, 60x40 for Montage to Stack.
