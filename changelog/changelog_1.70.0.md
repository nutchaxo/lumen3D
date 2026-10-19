# Changelog v1.70.0 (Web Platform)

## [ADDED]

- **Format 6: one display quality, WebP Q30**: every level of a dataset is now stored twice, losslessly (for measurements, exports and downloads) and in WebP quality 30 (for everything shown on screen). The ±2, ±4, light and very light copies of format 5 are gone. On E8.5 Em1 at native resolution, Q30 weighs 26 MB against 89 MB lossless, with a mean error of 1.5 grey levels out of 255. The fast cut stores (XY / XZ / YZ planes, oblique cut bricks) stay lossless. The normative contract is in SPEC Part IV, §15.
- **Data update `m006-q30` (format 5 → 6)**: converts a format-5 dataset in place. Each unit is one 4 × 4 × 4 block of lossless bricks, encoded once in WebP Q30, and no unit waits for another. The coarsest levels are converted first, so they are usable early. The update runs on the Python server or in the browser, with the same batches and request pieces as format 5. On a PHP host such as bemine it runs in the browser. The new manifest is the commit point: an update interrupted after it resumes by deleting the format-5 copies. A local copy of E8.5 Em1 converted in 23 s and its bricks went from 834 MB to 588 MB. A dataset still in format 4 is converted to 5, then to 6.
- **PHP hosts**: the PHP server has its own twin of m006, which plans the units, checks each result and assembles the tree. It produces the same tree as the Python server from the same results. It has no converter of its own, so on bemine the conversion runs in the browser. Checked end to end on a PHP server: a format-4 dataset was converted by the browser to format 5, then 6, and the result is a valid tree.
- **Import of a format-6 dataset**: the admin Import tab accepts a format-6 tree, which the preprocessing or `tools/convert_dataset.py` produces, on both servers. A file of a column the tree's format does not have is refused (`foreign_column`), for example a ±2 copy in a format-6 tree or a Q30 copy in a format-5 tree. So is a format-6 manifest whose columns are not exactly lossless + Q30.
- **Q30 download**: on a format-6 dataset, the Download Center offers the display bricks of the chosen levels as they are stored (`<dataset>.q30.zip`: the q30 index and packs, the manifest, the metadata and a README describing how to decode them), next to the lossless OME-Zarr export.
- **Tests**: `tests/test_format6.py` covers:
  - the engine;
  - the pipeline (`write_tree(fmt=6)` matches the format-5 tree in lossless, and m006 in Q30);
  - m006 on a volume and a timelapse;
  - the browser protocol, which gives the same tree as the server;
  - a finalize resumed after the commit point.

  Also new:
  - `tests/test_format6_php_parity.py`: the PHP and Python twins give identical plans, inputs, refusals, batches, pieces, a resumed finalize, trees, status rows and cancel.
  - `tests/test_format6_import.py`: Import of a format-6 tree on both twins.
  - `tests/js/test_format6_reader.mjs`: loader, column choice, Q30 download plan.
  - `tests/js/test_m006_handler.mjs`: the browser executor.

## [CHANGED]

- **Resolution only in the viewer**: on a format-6 dataset the quality control lists the resolutions alone, with their download size in Q30 and their GPU memory. A note says that every volume is displayed in WebP Q30 and that measurements and exports read the lossless data. The 3D view, the slice tool, the z-stack browser, region-of-interest detail and Compare all show Q30. The "lossless at rest" option does not apply to format 6.
- **Lossless exports at the resolution shown**: on a format-6 dataset every export is lossless, at the resolution chosen in the quality list, without the "current or lossless" question:
  - the 3D view image;
  - the Studio figure;
  - the Decompose panels.

  The Studio works on the Q30 picture of the volume on screen and runs its lossless pass only when a figure is exported. Measurements (`DataAccess`) read the lossless data, as before.
- **Pipeline**: the preprocessing writes format 6 by default (preprocess 0.23.0).

## [FIXED]

- **Studio "native lossless" export never exported**: after loading the native picture, the Studio checked a `quality` field of its document that does not exist. It concluded the load had failed and exported nothing. It now reads the quality of the picture it holds. This affected format-5 datasets too.
