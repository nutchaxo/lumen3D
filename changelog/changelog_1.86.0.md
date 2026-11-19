## [ADDED]
- **Library access for Studio plugins**: `ctx.studio.library` lets a Studio plugin list every dataset of the site and read one without mounting it in the viewer. It covers lossless z-stack planes (planes, layer MIPs or bricks), the bricks of an oblique plane (cut bricks, else lossless bricks), a dataset's original TIFFs in `download/` with their strip index, the photograph of a `2d` dataset, and a viewer link. The Advanced Studio uses it for File › Open from Library.
- **Original TIFF index endpoint**: `GET api/tiff-index?dataset=<type>/<folder>&file=<name>` (Python and PHP twins) returns the page and strip table of a TIFF in a dataset's `download/` folder. It reads only the TIFF headers (25–120 ms whether the file is 8 MB or 1.2 GB). The browser then fetches only the strips it needs with byte ranges, and those reads are not counted as downloads.
- **Advanced Studio 1.2.0, Fiji tools**: the Fiji commands a browser can run, with Fiji's own menu paths, dialog labels and defaults (captured from a real Fiji):
  - Auto Threshold and Auto Local Threshold, every method, Try all included;
  - Enhance Local Contrast (CLAHE), Tubeness and Frangi;
  - Add Noise, Add Specified Noise, Salt and Pepper;
  - FFT, Inverse FFT, FFT Options, Bandpass Filter, Swap Quadrants;
  - Directionality;
  - Coloc 2, Cell Counter, Analyze Skeleton (2D/3D), Local Thickness, Fractal Box Count and Curve Fitting (with Apply).
  Every output is checked against golden files recorded with ImageJ 1.54p and the user's Fiji.
- **Advanced Studio, ImageJ tools**:
  - ImageJ's remaining relevant commands: the selection operations (Fit Spline / Circle / Rectangle, Interpolate, Scale, Rotate, Make Band, Straighten, Line to Area, Area to Line) and the clipboard (Cut, Copy, Paste with Paste Control, Copy to System).
  - Draw, New Image, Make Montage, Duplicate as Duplicator, lookup-table files, Image › Overlay, Grid and Scale Bar.
  - Analyze: Histogram with List / Copy, Plot, Summarize, Distribution.
  - Repeat Command, Find Commands, Edit › Options.
  - The ROI file format and ROI sets, text images, Save XY Coordinates.
- **File › Open from Library**: picks any dataset of the site (search, type chips, thumbnails). It opens either a z-stack projection (first / last slice, projection type, resolution) or an oblique plane (yaw, pitch, roll, position, slab), and shows the size of the result and the bytes it will read before it starts. When the dataset has an original TIFF, the z-stack is read from it: raw intensities, the TIFF's own bit depth (16-bit stays 16-bit), only the planes of the range downloaded. Otherwise it reads the processed volume. The Z Project dialog of the Studio figure offers the same TIFF source.
- **Panel layout**: every image has its own view.
  - Split Channels lays out the original and each channel side by side.
  - A tab can be dragged onto a panel (centre = new tab, edge = split), minimised to a dock, popped out as a floating window or closed.
  - Dividers resize the panels (double-click evens them out), and Window › Tile / Cascade rearrange them.
  - The layout comes back after a reload.
- **About box**: says what Window › Results is for, where an image's pixels come from (original TIFF or processed volume), and lists every place where the Advanced view still differs from Fiji.

## [CHANGED]
- **Library images come back with the workspace**: after a reload, resuming a figure's saved work also brings back the images opened from the library beside it, in their panels. Each one keeps a saved session of its own, so File › Recover can still list it alone. Every session of a workspace records the others (`workspace` in the session meta), and resuming one restores the library sessions it lists. The other source of the same figure (original TIFF or processed volume) is still offered as a separate choice.
- **Edit › Options › Conversions takes effect**: "Scale when converting" now reaches Image › Type, and "Full range 16-bit inversions" reaches Edit › Invert. A 32-bit Invert now follows ImageJ's float order, about the display range.
- **Menus follow ImageJ**:
  - Window rows show the image's memory size ("blobs.gif 63K").
  - The Image › Adjust separators are where ImageJ has them.
  - Bandpass Filter and Fractal Box Counter remember their last values.
  - Repeat Command is the only command that re-opens a dialog with the previous values.
- **Analyze Skeleton replaces the Results table**, as Fiji does, instead of appending its rows to the previous measurements.
- **Coloc 2**: "ROI or mask" lists every open image (a wrong size or type is refused with a message), and the visible "Costes seed" column is gone.

## [OPTIMIZED]
- **Work moved off the main thread**: the Directionality orientation map, the Scale / Rotate / Interpolate of a mask selection and compressed TIFF decoding now run in the worker.
- **Long Fiji operations can be cancelled**: particle analysis, auto-threshold scans, skeleton cycle pruning, Costes randomisations and the FFT loops check for Cancel and declare their memory before allocating.
- **Directionality**: on a large image the pieces analysed form an evenly spaced grid that fills the 100-piece cap (13×13 pieces gave 7×7, now 10×10).

## [FIXED]
- **Original TIFF z-range**: a z-stack read from a TIFF no longer takes one plane too many when `metadata.json` rounds the z step to 6 decimals.
- **Cell Counter**: the panel failed to open in a real browser ("Something went wrong").
- **Library panel labels**: the Z Project source label shows the TIFF size with its unit. A photograph's TIFF is not described as a ".ims resolution level ?". A dataset whose processed volume cannot be read names it as such.
- **Picture files**: pictures opened with File › Open are decoded in bands up to 268 Mpx, and a larger one gets its own message.
