# Changelog v1.58.0 (Web Platform)

## [ADDED]

- **Data updates tab**: a new admin tab brings the datasets already published on a host up to the current data format, like software updates. It detects by itself which datasets need an update (or a repair), lists what is pending for each of them, and applies the steps one after the other — a dataset several versions behind gets every step in order, and "Update all" processes the datasets one at a time. Pause, resume, cancel and retry are available; a job resumes after a reload or a lost connection, and a log keeps the finished updates. Progress is shown in units, megabytes downloaded and sent, and remaining time.
- **Two ways to run an update, your choice**: the browser of the admin can do the work (it downloads the bricks, re-cuts them and sends the result back), or the server can (in short steps that stay within the time limits of a shared host). The tab checks whether the server can decode the bricks (WebP support in PHP's GD or Python's Pillow) and greys the server option out with the reason when it cannot. Both write to the same journal, so a job can switch from one to the other. Either way the tab must stay open while it runs.
- **Benchmark**: one button measures both ways on real units of a dataset — downloads and uploads included for the browser — and estimates the duration of every pending update. The result is a guide only: the operator picks freely.
- **Data format 2 — XY planes for the Studio**: the first update re-cuts each dataset's native level into XY planes (`planes/`: one file per z of 512² lossless greyscale PNG tiles with a fixed index). The bricks are kept for the 3D view and the other cuts. A native XY cut or z-stack figure in the Studio then downloads only the tiles of the planes it shows instead of whole 64-slice brick layers — tens of times fewer bytes on the large datasets — with a pixel-identical result; on any problem with the planes the Studio falls back to the bricks. The planes take about 1.3× the native level's brick size on disk.
- **New datasets come out in format 2**: the processing pipeline (0.20.0) writes the planes and `formatVersion: 2` itself, so a freshly processed dataset needs no update, and the Import tab accepts the `planes/` folder (sent last, after the rest of the dataset is usable).

## [CHANGED]

- **Format version in metadata.json**: a dataset carries `formatVersion` (absent = 1). It belongs to the pipeline and the updates; the dataset editor and the curation merge never change it. The contract shared by the browser, the Python server and the PHP server is in `DOCS/dataset-migrations/SPEC.md`.
- **Studio confirmation for large figures**: on an updated dataset the dialog states the planes and image tiles the figure will read, and no longer offers a lower level that would cost more.

## [FIXED]

- **Updates are safe on a live site**: a job refuses to start when the disk cannot hold it, takes the same lock as the dataset editor for the version bump, publishes files readable by the web server, never swaps stale planes into a dataset that was re-processed meanwhile, never re-creates a deleted dataset, and stays within a 128 MiB PHP memory limit on the largest manifests (23 MB manifests decoded in 40 MB, the derived plan cached between requests).
