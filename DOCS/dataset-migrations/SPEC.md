# Dataset migrations — specification (web 1.58.0)

Datasets already published on a host are upgraded in place, like software updates: each
dataset carries a **format version**, the platform knows an ordered list of **migrations**
(`from → to`), and the admin tab **Data updates** applies the pending ones to each dataset,
one after the other, with either of two **executors**. This document is the contract shared
by the browser, the Python server and the PHP server. Every number and byte layout below is
normative; the three implementations must produce pixel-identical results.

## 1. Format versions

* `metadata.json` key **`formatVersion`** (integer). Absent ⇒ **1** (every dataset published
  before web 1.58.0).
* **LATEST = 2.**
* A dataset "needs an update" when `formatVersion < LATEST`, **or** when its version claims a
  structure that is missing or invalid on disk (e.g. version 2 without a readable
  `planes/manifest.json` in every brick tree) — the tab offers to repair it by re-running the
  migration that produces that structure.
* Only published datasets (`DATA_WEB/<type>/<folder>`) of the volume types `3d` and `live`
  are migrated. `2d` datasets have no migration today (they are listed as up to date).
* The pipeline (preprocess ≥ 0.20.0) writes `formatVersion: 2` and the structures of
  version 2 directly; a re-processed dataset needs no migration.
* `formatVersion` is a pipeline-owned key, never curated: `merge_curated` must not carry an
  old value over a freshly produced one. The editor never writes it.

## 2. Migration registry

One ordered list, identical in the three twins (`dataset_migrations.py:MIGRATIONS`,
`api/_migrations_lib.php:LUMEN_MIGRATIONS`, and what `status` returns to the browser):

| id | from | to | title (en) | applies to |
|---|---|---|---|---|
| `m002-planes` | 1 | 2 | Plane-major copy of the native level (fast XY cuts in the Studio) | `3d`, `live` |

Each entry: `{ id, from, to, types, title: {en,fr,es,nl}, description: {en,fr,es,nl} }`.
A dataset at version v gets every migration with `from >= v` in order; a migration is
applied only when the dataset is exactly at its `from` version. Adding a migration later =
append an entry (with its unit planner and both executors); nothing else in the framework
changes.

## 3. Format 2 — `planes/` (migration `m002-planes`)

For **every brick tree** of the dataset — `bricks/` for a `3d` dataset, each
`bricks/tNNN/` for a `live` one (the trees the viewer reads through `bricks/manifest.json`
and its `timepoints`) — a sibling directory **`planes/`** holds the native level (LOD0)
re-cut into XY planes. Paths: `3d`: `<ds>/planes/…`; `live`: `<ds>/planes/tNNN/…` (same
`NNN` as the brick tree). The bricks are untouched; the viewer keeps using them for 3D and
for XZ/YZ/oblique cuts.

### 3.1 `planes/manifest.json` (per tree)
```json
{
  "schema": "lumen-planes-v1",
  "formatVersion": 2,
  "level": 0,
  "dimensions": { "x": 3789, "y": 3789, "z": 257 },
  "channels": 4,
  "tileSize": 512,
  "tiles": { "x": 8, "y": 8 },
  "codec": "png-gray8",
  "packPattern": "z{z}.bin",          // z zero-padded to 5 digits: z00000.bin
  "headerBytes": 3088,                 // 16 + 12 · channels · tiles.y · tiles.x
  "source": { "manifestSha256": "<sha256 hex of the bricks manifest bytes>" },   // live: the one bricks/manifest.json, same value in every tree
  "producer": "pipeline" | "migration-browser" | "migration-server" | "mixed",
  "createdAt": "<ISO-8601 UTC>"
}
```
Compact JSON (`separators=(',',':')`), UTF-8, written atomically.

### 3.2 Plane pack `planes/zNNNNN.bin` (one per z, 0-based, 5-digit zero pad)
Little-endian.
```
offset 0   : magic   4 bytes  "LPLN"
offset 4   : version u16      1
offset 6   : channels u16     C
offset 8   : tilesX  u16      TX
offset 10  : tilesY  u16      TY
offset 12  : z       u32
offset 16  : C·TY·TX entries, order c-major, then ty, then tx:
             { offset u64 (from the start of the file), length u32 }   (12 bytes)
then       : tile payloads, in entry order, concatenated (no padding)
```
* `length = 0` **if and only if** the tile is entirely zero (no payload; `offset` = 0). Every
  producer drops every all-zero tile. Packs from different encoders are compared by decoded
  pixels (zlib builds differ); headers are identical only when assembled from the same tile store.
* `headerBytes = 16 + 12·C·TY·TX` is identical for every z of a tree, so a client range-reads
  `[0, headerBytes)` without any other index.

### 3.3 Tile payload — `png-gray8`
* A standard PNG: signature, `IHDR` (width = `min(512, X − tx·512)`, height =
  `min(512, Y − ty·512)`, bit depth 8, colour type 0 = greyscale, compression 0, filter 0,
  interlace 0), one or more `IDAT`, `IEND`. **No** `gAMA`, `cHRM`, `sRGB`, `iCCP`, `tEXt`
  (a browser must decode the bytes verbatim, without colour management).
* Pixel (x, y) of tile (c, ty, tx) of plane z = the stored uint8 voxel of channel c at
  (tx·512 + x, ty·512 + y, z) of LOD0 — exactly the value the brick decoder produces for that
  voxel (lossless; no rescale, no LUT). Voxels of bricks absent from the manifest (dropped by
  ESS) are 0.
* Encoders may choose any PNG filter per row and any deflate level; the decoded pixels are
  what must match. Reference choice (all producers): filter 0 (None) on every row, zlib
  level 6 — measured on 2,264 real native tiles it is 4 % smaller than Sub overall (up to
  42 % on sparse timelapses) and cheaper to compute.

## 4. Work units and the job journal (server side, shared by both executors)

* A **unit** = `(t, bz, c, ty, tx)`: one brick layer `bz` (64 z planes, fewer at the end), one
  channel, one 512×512 XY tile (= 8×8 bricks) of one tree `t` (`t = 0` for a `3d` dataset).
  Key string: `t{t}.z{bz}.c{c}.y{ty}.x{tx}`. Processing a unit = decode the ≤ 64 bricks of that
  tile/layer/channel, then emit up to 64 tiles (one per z in the layer).
* Units whose 64 bricks are all absent from the manifest are **empty**: marked done at plan
  time, no work, their tiles get `length = 0`.
* **Journal** `uploads/migrations/<type>__<folder>__<migrationId>.json` (uploads/ is never
  served): `{ migration, dataset, createdAt, sourceManifests: {t: sha256}, units: {total,
  empty}, done: [keys…] (or a compact bitmap), executors: {browser: n, server: n}, state:
  "running"|"assembling"|"done"|"failed", error? }`. Written atomically under a lock.
* **Tile store** `uploads/migrations/<type>__<folder>__<migrationId>/t{t}/z{z}/c{c}.y{ty}.x{tx}.png`.
  Writing a unit replaces its tiles (idempotent): a retried or duplicated unit is harmless,
  and a job can switch executor at any time.
* A source manifest whose sha256 changed since the plan (dataset re-processed meanwhile)
  invalidates the job (`state: failed`, error `source_changed`).

## 5. Server API — `/api/migrations.php` (Python route identical)

All actions require the admin session; mutating ones require the CSRF header and POST.
JSON answers. Session lock released after authentication (cf. `session_write_close`).

| action | method | input | output |
|---|---|---|---|
| `status` | GET | — | `{ latest, migrations:[registry entries], datasets:[{ id, type, folder, formatVersion, pending:[ids], repair:bool, trees, job: journal summary or null, estimate:{units, bytes} }], server: { available, reasons:[codes], webpDecode, pngEncode, limits:{ maxExecutionTime, memoryLimitBytes } } }` |
| `plan` | POST | `{ dataset, migration }` | journal summary `{ total, empty, done, units:[pending keys] (paged: offset/limit) }` |
| `unit_put` | POST (binary, `Content-Type: application/octet-stream`) | query `dataset, migration, unit, dry=0/1`; body = **unit blob** (§5.1) | `{ ok, done, total }` (`dry=1`: body read and discarded — upload benchmark) |
| `unit_run` | POST | `{ dataset, migration, maxSeconds (≤ 20, clamped to max_execution_time − 5), dry }` | `{ processed:[keys], done, total, seconds, bytesRead }` |
| `finalize` | POST | `{ dataset, migration, maxSeconds?, keepPrevious? }` | `{ ok, complete, formatVersion?, assembly:{planes, written} }` — assembles, validates, swaps, bumps; resumable: call again until `complete:true`. `keepPrevious: true` (JSON true only; m004) keeps the replaced tree as `bricks.previous/` (§13.6) |
| `cancel` | POST | `{ dataset, migration }` | deletes journal + tile store |
| `drop_previous` | POST | `{ dataset }` | `{ ok, dropped }` — deletes the dataset's `bricks.previous/` (idempotent; web 1.60.4) |
| `bench` | POST | `{ dataset, units: N (≤ 8) }` | server executor on N sample units (dry: tiles discarded) → `{ seconds, units, bytesRead, bytesWritten }` |
| `speedtest` | POST | `{ maxSeconds (≤ 3) }` | server side of the speed test (§7): test blocks back to back until the next one would end past `maxSeconds` (≥ 1 block) → `{ blocks, seconds, bytesRead, bytesWritten }`; needs m002's capability (409 `server_unavailable` otherwise) |
| `speedtest_put` | POST (binary) | body = one converted test batch (≤ 4 MiB) | `{ ok, bytes }` — read and dropped |
| `speedtest_sample` | GET (binary answer) | query `n` (1..16) | the test brick repeated n times (one download per browser batch) |
| `read_ranges` | POST (JSON body, CSRF; binary answer) | `{ dataset, ranges: [[rel, start, end], …] }` — rel a `.bin` under `bricks/`, `planes/` or `mips/` of the dataset, end exclusive, ≤ 1024 runs, ≤ 32 MiB | `uint32 LE count`, `count × uint32 LE length`, then the runs in request order; every run checked before a byte is read (400 `bad_range`, 413, 416, 404 `range_missing`). A browser unit's input runs in one request (web 1.59.3) |
| `store_get_many` | GET (binary answer) | query `dataset, migration=m004-bricks-v3, base=t{t}.k{k}.c{c}, bricks=z.y.x,…` (≤ 128) | `uint32 LE count`, `count × uint32 LE length` (0 = not stored, interior zero), then the bricks in request order — replaces one `store_get` per brick (web 1.59.2) |

`server.available` is false with reason codes when the server executor cannot run:
`no_webp_decode` (PHP: `imagecreatefromwebp` missing or fails on a lossless sample; Python:
Pillow without WebP), `no_zlib`, `low_memory` (< 128 MiB), `exec_time_too_short` (< 10 s).
The probe decodes a tiny embedded lossless WebP and checks exact pixel values.

### 5.1 Unit blob (browser → server)
```
u32 count
count × { u32 z, u32 length, length bytes of PNG }   (z = absolute plane index)
```
Max body 32 MiB; z must belong to the unit's layer; every PNG must start with the PNG
signature and carry an IHDR of the expected size and colour type 0 (checked server-side).

### 5.2 Finalize
1. Every unit done, source manifests unchanged.
2. For each tree and z: build `zNNNNN.bin` (header + tiles in entry order) into
   `<ds>/.planes-incoming/` (or `.planes-incoming/tNNN/`); verify every tile's IHDR.
3. Write each `planes/manifest.json` (`producer` = browser / server / mixed from the journal).
4. Swap: rename an existing `planes/` aside (`.planes-old`), rename `.planes-incoming` to
   `planes`, delete the old one.
5. Bump `metadata.json` `formatVersion` to the migration's `to` — atomically, under the
   metadata lock, merging into the current file (never overwriting other keys).
6. Delete the journal and the tile store.
Dot-folders are never listed in the catalog (existing rule). A crash between 4 and 5 leaves
a valid `planes/` and version 1 ⇒ the dataset shows as "needs update" and finalize is
idempotent.

## 6. Executors

* **Browser (A)** — `js/workers/migration-worker.js` + per-migration handler
  `js/migrations/m002-planes.js`. For each pending unit: range-fetch the unit's bricks from
  the packs (same `brickToPack` index and `?v=` stamp as the viewer), decode (WebP lossless →
  64³ un-mosaic, exactly like `brick-decode-worker.js`), cut the planes, encode PNG
  (`js/core/plane-codec.js`, shared with the reader), POST the unit blob. Parallelism: a few
  units in flight, bounded memory. Resumes from the server journal (`plan` returns pending
  keys). The tab must stay open; closing it pauses the job.
* **Server (B)** — the tab loops `unit_run` calls (each one bounded in time) until done, then
  `finalize`. The tab must stay open too (shared hosts have no background workers); it shows
  that clearly.
* Both executors write the same journal, so a paused job can be resumed by the other one (the
  tab fixes a dataset's executor while it runs; the operator changes it between runs).

## 7. Speed test (web 1.59.1; replaces the per-dataset benchmark of 1.58/1.59)

One button, no parameter, no dataset: both executors convert the **same synthetic test block**
at the same time for **5 seconds**, and the one that converted more blocks wins.
* Test block = what a unit does per brick it reads: decode the 512² lossless-WebP mosaic of one
  64³ brick, encode its voxels as one 512² `png-gray8` tile. The input is the fixed file
  `js/migrations/speedtest-brick.webp` shipped with the platform (Gaussian blobs over Poisson
  shot noise, like a confocal stack; ~128 KiB).
* Browser: the worker pool at its normal concurrency (workers × slots), in batches of 16 blocks:
  one `speedtest_sample?n=16` download, decode + encode of each block in a worker, one upload of
  the 16 tiles to `speedtest_put` — the bytes a real browser unit moves, in two requests per batch,
  under the network governor (§7.2). A batch counts when it ends inside the window (a browser
  that finishes none gets one more window); the pool is terminated at the deadline.
* Server: `speedtest` calls of ≤ 1 s back to back until the window ends (one request at a time,
  like `unit_run`).
* Score = blocks per second × 10, each side over the time of its last completed batch / call.
  The winner is the default executor of every dataset the operator has not set. The `bench`
  action is kept for tools.

## 7.1 Executor per dataset

The tab chooses the executor **per dataset**, before it starts: the operator's pick (kept in the
browser's localStorage), else the speed test's winner, else the browser, else the server. Each
executor has its own queue (a `Runner` lane): datasets given to different executors are
converted in parallel; datasets on the same executor one after another. A step the chosen
executor cannot run (capabilities §13.5) runs on the other one within the same lane, so a
dataset's steps stay in order. The choice is locked while the dataset is queued or running.

## 7.2 Network governor (web 1.59.2)

A shared host's firewall bans an address that opens too many connections or sends too many
requests per second (web 1.59.1 got the operator's address banned: two worker pools, one
`store_get` per stored brick, an unbounded speed test). Every request of the tab — its API calls
and every worker fetch, of every pool — goes through ONE governor per page
(`migration-runner.js` `NetGovernor` / `netGovernor`; workers ask for a turn with `net_acquire`,
get `net_grant`, and return it with `net_release { outcome }` once the body is read):
* at most 6 requests in flight, a token bucket of 4 starting at 4 requests/s, never above 6/s
  (web 1.59.3; 10–16/s in 1.59.2, before a unit's inputs travelled in one request);
* a request without HTTP answer, a 429 or a 503 halves the rate (floor 0.5/s) and holds every
  new request for a cooldown (5 s, doubling to 60 s while failures go on); each answer raises the
  rate by 0.2/s. The tab says when requests are being held.
* a unit's input runs travel in ONE `read_ranges` answer (a layer projection: the missing plane
  headers in one, its 64 tiles in another), its level-k bricks in `store_get_many` answers of 128,
  its result in one `unit_put` — about three requests per unit (a server without `read_ranges`
  answers 400 *unknown action* and the worker falls back to one Range request per run).
Measured on the synthetic pair of the tests (two 1100×900×130 / 1000×900×130 2-channel volumes,
one per executor, formats 1 → 4): 1.59.1 ≈ 3 400 requests at over 40/s; 1.59.2 3 443 requests,
8/s on average, 436 s; 1.59.3 424 requests, 3.7/s on average, 11 in the busiest second, 115 s.

## 8. Reader (viewer / Studio)

* `js/core/plane-loader.js` (`PlaneLoader`): `open(treeBase)` reads `planes/manifest.json`
  (validated: schema, dimensions equal to the bricks' LOD0, codec, headerBytes); `loadRegion(z,
  channels, rect, { signal })` range-reads the header (cached per z) and the needed tiles
  (merged byte runs, `?v=` stamped from the planes manifest), decodes in workers with the JS decoder of `plane-codec.js` (`PlaneCodec.decodePngGray`,
  normative: canvas read-back is not guaranteed exact — anti-fingerprinting noise, colour
  management), DecompressionStream required (without it the bricks are used),
  and returns the uint8 region per channel.
* The Studio's native pass uses it for **XY** cuts (single plane, and z-stack slabs: one plane
  per z of the slab, per-channel max for a MIP — same semantics as the bricks plane path) at
  LOD0 when the dataset's tree has a valid `planes/`; otherwise the bricks path. Output must be
  pixel-identical to the bricks plane path. XZ/YZ/oblique keep the bricks.

## 9. Admin tab "Data updates" (`tab-dataset-updates.js`)

* Lists: pending migrations (title, description), every volume dataset with its version,
  what is pending, an estimate (units, bytes), job progress if one exists (resumable).
* Speed test card (§7): one bar and score per executor, the winner, the reason an executor
  cannot run.
* One row per dataset that needs work: steps, a browser / server switch (§7.1; an executor that
  can run none of the steps is disabled with the reason), update / resume / retry / cancel, and
  its live progress (step, % units, rate, ETA). Datasets already up to date fold away.
* Actions: update one dataset, update all (each with its own executor), pause / resume every
  lane, cancel a job, retry a failed one. History of finished steps (folded).
* Leaving the tab with a job running asks for confirmation (it pauses every lane).
* Generic: nothing in the tab is specific to `m002-planes` except the handler module the
  browser executor loads for that id.

## 10. Tests (minimum)
* Format parity: the three encoders' tiles decode to identical pixels; pack headers
  identical; Python and PHP finalize produce identical `planes/` trees from the same tile store.
* Brick → plane exactness against the existing JS brick decoder on real local bricks.
* Journal: idempotent units, executor switch mid-job, source change detection, crash between
  swap and version bump.
* Reader: `PlaneLoader` regions equal the bricks path; Studio XY native via planes equals the
  bricks plane path pixel for pixel.
* Pipeline: a fresh dataset has `formatVersion: 2` and planes equal to the migration's.

## 11. Import of a format-2 dataset
The browser Import allowlist (`upload_staging.classify_path`, `api/_upload_lib.php:lumen_up_classify`) accepts `planes/manifest.json`, `planes/zNNNNN.bin` and `planes/tNNN/…` of a dataset made by preprocess ≥ 0.20.0; planes are uploaded in the last tier (the dataset is viewable before they arrive). A dataset published without them stays at the version its metadata claims only if the structure is complete — otherwise it is listed as needing a repair.

---

# Part II — web 1.59.0: formats 3 and 4

LATEST becomes **4**. Registry (append, in order):

| id | from | to | title (en) | applies to |
|---|---|---|---|---|
| `m003-layer-mips` | 2 | 3 | Maximum projections of each brick layer (fast whole-stack z-stack figures) | `3d`, `live` |
| `m004-bricks-v3` | 3 | 4 | Brick pyramid v3: halved in Z too, 1-voxel border, binary index | `3d`, `live` |

A dataset at version 1 runs m002 → m003 → m004 in order. The pipeline (≥ 0.21.0) writes
format 4 directly. Repair rule (§1) extends to every structure a version claims.

## 12. Format 3 — `mips/` (migration `m003-layer-mips`)

Per tree, beside `planes/`: `mips/` (live: `mips/tNNN/`). For every brick layer `bz`
(planes `z ∈ [64·bz, min(64·bz+64, Z))`) and channel `c`, the per-voxel **maximum over the
layer's planes** of LOD0, at native XY resolution, tiled exactly like planes.
* `mips/manifest.json`: same shape as §3.1 with `"schema": "lumen-mips-v1"`, `"formatVersion": 3`,
  `"layers": ceil(Z/64)`, `"layerDepth": 64`, `"packPattern": "l{l}.bin"` (5-digit pad),
  `source.manifestSha256` = sha256 of the bricks manifest bytes (format 4 re-stamps it, §13.6).
* `mips/lNNNNN.bin`: the §3.2 pack layout with header field `z` = layer index `l` (magic `LMIP`).
  Tiles: png-gray8, filter None, `length = 0` iff the tile is all zero.
* Derivation: from `planes/` (decode the layer's ≤ 64 planes of a tile, per-voxel max). Exactly
  equal to the max of the LOD0 voxels. Work unit = `(t, l, c, ty, tx)`, key
  `t{t}.l{l}.c{c}.y{ty}.x{tx}`; inputs are plane tiles (range reads of plane packs).
* Reader: a z-stack slab `[z0, z1)` with MIP = max over (layer MIPs of the layers fully inside
  the slab) ∪ (planes of the partial layers at both ends) — pixel-identical to the max over
  planes. A layer MIP is used only when the slab's sampling covers every plane of the layer
  (the Studio's z-stack figures sample one plane per slice).

## 13. Format 4 — brick pyramid v3 (migration `m004-bricks-v3`)

The tree `bricks/` is replaced by a v3 tree (same directory name; the swap of §5.2 applies,
`bricks.v2-old` removed after the version bump). planes/ and mips/ are unchanged.

### 13.1 Levels — halved in X, Y **and Z**, aspect preserved
* Level 0 = LOD0 voxels **verbatim** (decoded from the v2 bricks — never resampled).
* Level k+1 from level k: X and Y halved (`ceil(n/2)`); Z halved **only when** the level-k voxel
  is not already coarser in Z than in XY: halve Z iff `vz_k ≤ 1.5 · vxy_{k+1}` where `vxy` is the
  XY voxel size (µm) after this step (isotropy-seeking, OME-Zarr style). Voxel sizes per level are
  written in the manifest.
* Reduction: mean of the 2×2(×2) source block (edge blocks average only the voxels that exist),
  in integers, rounded half up: `(sum + n/2) // n`. Same arithmetic in the three implementations.
* When Z is already 1 plane, a "halving" keeps 1 plane and doubles the Z voxel size.
* `vxy` = the larger of the two XY voxel sizes; an uncalibrated volume is treated as cubic voxels.
* Levels stop when `max(X, Y) ≤ 128` at the coarsest level (at least 1 level besides level 0
  when `max(X,Y) > 128`).
* ESS: a level-k brick is kept iff it holds at least one voxel ≥ 1 (exact, no occupancy
  tolerance). (The v2 tolerance dropped real signal; level 0 keeps exactly the v2 bricks' content
  — a v2 brick absent from the manifest is zeros.)

### 13.2 Bricks with a 1-voxel border (apron)
* Brick (bx, by, bz) of level k covers interior voxels `[64·b, 64·b+64)` per axis and is stored as
  **66³**: voxels `[64·b − 1, 64·b + 65)`. Outside the volume: clamp-to-edge (replicate the edge
  voxel). A neighbour brick dropped by ESS contributes zeros (it is zeros).
* Mosaic: 66 slices of 66×66 (z-major), laid out in a grid of **9 columns × 8 rows** (72 slots,
  the last 6 empty = 0) → a 594×528 greyscale image, slice s at column `s % 9`, row `s // 9`.
* Encoding: **WebP lossless** (same as v2; one channel per image).
* A brick is **stored iff its 64³ interior holds a voxel ≥ 1**; a brick absent from the index is
  all zeros, border included (a reader never reconstructs a border from neighbours).

### 13.3 Manifest v3 (`bricks/manifest.json`, compact) + binary index
```json
{ "schema": "iribhm-bricks-v3", "version": 3, "formatVersion": 4,
  "channels": C, "brickSize": 64, "apron": 1, "brickPacking": {"mode":"grid","cols":9,"rows":8,"slice":66},
  "encoding": "webp-lossless",
  "levels": [ { "level": 0, "dimensions": {"x","y","z"}, "voxelSize": {"x","y","z"},
                "gridSize": {"x","y","z"}, "brickCount": n } … ],
  "timepoints": null | [ { "path": "t000", "index": { "url": "t000/index.bin", "bytes": N, "sha256": "…" } }, … ],   // live: one index per tree
  "index": { "url": "index.bin", "bytes": N, "sha256": "…" },
  "histograms": [ … ], "timepointHistograms": { "t000": [ … ] } (live, optional), "createdAt": "…" }
```
`index.bin` (per tree, little-endian): magic `LBIX`, u16 version 1, u16 levels, u16 channels,
u16 reserved; per level: u32 gridX, gridY, gridZ, u32 packCount; then per level, per channel,
per brick in order (bz, by, bx): `{ u16 pack, u32 offset, u32 length }` (10 bytes; length 0 =
brick absent ⇒ zeros); then the pack names table: per level, per channel, packs named
`l{k}/c{c}/p{NNNNN}.bin` (implicit, no strings). A client fetches `index.bin` once
(~10 bytes per brick slot: 18 572 LOD0 bricks × 4 channels ≈ 0.74 MB raw, gzip on the wire).
Pack URLs carry `?v=<first 12 hex of index sha256>`. `packCount` = total packs of the level over all channels; `brickCount` = bricks present (length > 0) in the level over all channels. For a `live` dataset the root `index` is absent and each timepoint row carries its own `index` (paths relative to `bricks/`).

### 13.4 Packs
`l{k}/c{c}/pNNNNN.bin`: concatenated brick images. Bricks are grouped by **super-block** (4×4×4
bricks, the m004 work unit): super-blocks in order (SBZ, SBY, SBX), and inside a super-block the
bricks in order (bz, by, bx); absent bricks are skipped. A pack holds whole super-blocks: a new
pack starts before a super-block that would take the pack past 64 bricks or 16 MiB; a single
super-block larger than 16 MiB (or than 64 bricks) is split in brick order across consecutive packs:
a new pack starts before a brick when the pack is non-empty and holds 64 bricks or the brick
would take it past 16 MiB; the super-block that follows a split may join the split's last pack
if it fits. Empty super-blocks are skipped. Measured on a 5735²×172 embryo (simulated): a YZ
native cut touches 66 packs instead of 668, an XZ cut 52 instead of 18 (≈ 118 multi-range
requests for both instead of 686); XY cuts are served by `planes/`. (Grouping by
super-block keeps an XZ or YZ cut — which crosses one brick row/column per super-block — to a few
packs, so its byte runs merge into a handful of multi-range requests.) Pack numbering is per
(level, channel), from 0. The reader never assumes an order: `index.bin` gives each brick's pack,
offset and length.

**Live index URL (§13.3)**: `timepoints[i].index.url` is relative to `bricks/` (e.g.
`t000/index.bin`); a reader mounting the tree `bricks/t000/` resolves it against `bricks/`.

### 13.5 Derivation (migration) — units
Work unit = `(t, k, c, BZ, BY, BX)` super-block of 4×4×4 bricks of level k (key
`t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}`). Level 0 units read the v2 LOD0 bricks of their block +
the 1-voxel neighbourhood (decode only what is needed); level k+1 units read level-k v3 bricks
(a level is processed only after the previous level is complete — the journal orders units by
level). Executors: browser (needs lossless WebP encoding: `OffscreenCanvas.convertToBlob({type:
'image/webp', quality: 1})` verified lossless by decoding back at probe time — otherwise the
browser executor is unavailable for m004 with reason `no_webp_lossless_encode`), server (Python
Pillow `lossless=True`; PHP GD `imagewebp($im, $f, IMG_WEBP_LOSSLESS)` — PHP ≥ 8.1 with WebP;
probe = encode + decode a sample exactly).
Capability is reported **per migration and per executor** (`status.server.migrations[id]`,
browser probe per handler).

### 13.6 Finalize
Assemble packs + `index.bin` + manifest v3 into `.bricks-incoming/`, swap `bricks/` ↔ it, re-stamp
`planes/manifest.json` and `mips/manifest.json` `source.manifestSha256` with the new manifest's
sha256 (their voxels are LOD0, unchanged), bump to 4. Old `bricks.v2-old/` deleted after the bump —
or, with `keepPrevious: true` on the finalize call that completes, renamed `bricks.previous/`
(replacing an older one): byte for byte the v2 tree the dataset had, never read by a migration,
reported by `status` as `previous: { schema, bytes }`, shown by `viewer.html?bricks=previous`
(the page mounts `bricks.previous/` instead of `bricks/`; the planes/mips are not stamped for it,
so the Studio reads its bricks), deleted by `drop_previous` (web 1.60.4).

### 13.7 Reader (viewer)
`BrickLoader` reads v2 and v3 (by `schema`). v3: binary index, packs per (level, channel), decode
the 9×8 mosaic of 66² slices → 66³ brick; the SVR atlas stores 66³ slots and the ray-marcher
samples with hardware trilinear filtering inside a slot (texture coordinate = slot origin + 1 +
local·64 voxels), so filtering is seamless across bricks at every quality. Quality presets map to
levels by the level's XY size: "512" = the finest level with `max(x,y) ≤ 768`, "1024" ≤ 1536,
"native" = level 0; labels show the real dimensions.

### 13.8 Decisions fixed during implementation (normative)
* Voxel size of level 0: manifest `voxelSize`, else metadata `voxel_size`, else 1 µm (cubic).
  A halved axis doubles its voxel size exactly.
* Pack sizing: see §13.4 (whole super-blocks per pack, ≤ 64 bricks / 16 MiB).
* Interior padding beyond the volume (last partial brick) is clamp-to-edge, like the border.
* `m004` refuses (`trees_differ`) a timelapse whose frames differ in dimensions.
* Damaged v3 bricks cannot be repaired by m004 (the v2 source is gone): reported as
  `problem: bricks_v3_invalid`, not as a pending repair.
* `plan` returns the units runnable **now** (`units`), with counts `runnable` / `pending`; for
  m004 also `levels: [{dimensions, voxelSize, gridSize, halveZ, units, done}]`. A level-k unit of
  a tree/channel is runnable once every lower level of that tree/channel is done; an early
  `unit_put` answers 409 `unit_blocked`.
* Extra actions: POST `unit_inputs` (lists a unit's inputs), GET `store_get`
  (`&brick=t.k.c.z.y.x`, streams a stored level-k v3 brick of the job, 404 `absent` when it was
  dropped) — what the browser executor reads level k back through.
* m004 browser blobs: each brick must be lossless **VP8L**, 594×528, opaque, the 6 unused
  mosaic slots zero.
* Encoder reference: Pillow `lossless=True, quality=75, method=4` (pipeline and Python
  migration byte-identical); other encoders are compared by decoded voxels.
* Re-stamp (§13.6) only rewrites planes/mips manifests that carried the old v2 sha.

### 13.9 Short time limits (shared PHP hosts)
* Before every step the server calls `set_time_limit()`; `status.server.limits.resettable` says
  whether the host honours it (otherwise the deadline is request start + `max_execution_time`).
* An m004 unit may be processed by the SERVER in 8 octants (2×2×2 bricks of the super-block):
  each octant's bricks go to the normal tile store and are recorded in `journal.partial[key]`;
  the unit is marked done only when every non-empty octant is stored (same keys, same store
  layout). Octants are used when no whole unit of that level has been timed yet, when the
  slowest timed one (+25 %, `journal.timing`) would not fit, after any request death at that
  level, or once a unit has octants stored. `unit_run` answers `partial: [{unit, parts, of: 8}]`;
  the client counts more stored octants as progress. A browser `unit_put` of the whole unit
  overwrites it and clears `partial` / `attempts`.
* `journal.attempts[key]` is written before a step starts; a unit that killed its request twice
  is answered 409 `{error: "unit_timeout", unit, attempts}` — the journal stays `running`, every
  other unit's progress is kept; the tab switches that migration to the browser executor. A new
  `plan` resets the counts.
* `bench` stops at the time budget and reports `unitsMeasured` (m004 measured octant by octant
  under a limit).

# Part III — web 1.63.0: format 5 (resolution × compression matrix, cut stores, lossless access)

LATEST becomes **5**. Registry (append):

| id | from | to | title (en) | applies to |
|---|---|---|---|---|
| `m005-matrix` | 4 | 5 | Full-depth pyramid at 256·2ᵏ, compression columns, fast cut stores | `3d`, `live` |

The platform is first a place to **look**: what is displayed may be compressed with loss as long
as the picture is not visibly altered. Everything that **measures** (measurement tools, plugins,
exports in native quality) reads the lossless native voxels through §14.8. Format 5 therefore
stores the same volume several times: once per (resolution, compression) cell for display, once
lossless at native resolution for measuring, and three re-cut copies for fast cuts (§14.5).
Disk is spent freely; bytes on the wire and GPU memory are not.

The source of every structure is the **lossless level 0 of the format-4 tree** (the native
voxels, never resampled; read through `planes/`, which holds the same voxels plane by plane).
The raw acquisition (`.ims`) is never needed. The pipeline (≥ 0.22.0) writes format 5 directly.

## 14. Format 5

### 14.1 Levels (the rows of the matrix)
* `N = max(X, Y)` of level 0. Targets `T_j = 256 · 2^j` for every `j ≥ 0` with `T_j < N`. The
  levels are **level 0 = native** followed by the targets from the largest down:
  5192×5192×312 → `0: 5192×5192×312`, `1: 4096×4096×312`, `2: 2048…`, `3: 1024…`, `4: 512…`,
  `5: 256×256×312`. A volume with `N ≤ 256` has level 0 only. Every power of two below `N` is
  always made, even when it is close to `N` (520 → 512 and 520): equal labels compare across
  datasets.
* Dimensions of a level with target `T`: the long XY axis is exactly `T`; the other XY axis is
  `max(1, (2·n·T + N) // (2·N))` (n·T/N rounded half up); **Z is never reduced** (every plane of
  level 0 is in every level). Voxel size: `v' = v · n₀ / n'` per XY axis, `vz' = vz`.
* Resampling — exact **area average** from level 0, integers, one rounding, the same in every
  implementation. Along an axis of `n₀` source voxels and `n'` output voxels, source voxel `j`
  covers `[j·n', (j+1)·n')` and output voxel `i` covers `[i·n₀, (i+1)·n₀)` on an integer line of
  length `n₀·n'`; `w(i, j)` = the length of their overlap (an integer; `Σⱼ w(i,j) = n₀`). Then
  `out(iₓ, i_y, z) = (Σ wₓ(iₓ,jₓ)·w_y(i_y,j_y)·v(jₓ,j_y,z) + D/2) // D` with `D = X₀·Y₀`. The
  sum may reach `255·X₀·Y₀` (≈ 8.4·10⁹ for 5735²): 64-bit integers (PHP needs a 64-bit build;
  JavaScript stays exact below 2⁵³). Computed separably (X pass then Y pass, sums kept, no
  intermediate rounding), every level **directly from level 0**, plane by plane: a level is never
  derived from another level.
* ESS: a brick of any level is stored iff its 64³ interior holds a **source** voxel ≥ 1 (decided
  on the level's exact voxels, never on a decoded lossy copy).

### 14.2 Bricks
Bricks keep the v3 geometry of §13.2: 64³ interior + 1-voxel clamp-to-edge apron (66³), absent
brick = zeros including its apron. The mosaic depends on the column's codec (§14.3):
* **`grid66`** — the §13.2 mosaic: 66 slices of 66², 9 × 8 slots, 594 × 528.
* **`grid80`** — for the lossy codecs: the same 9 × 8 slots on an **80-pixel pitch**, each 66²
  slice centred (7 pixels of edge replication on each side) → 720 × 640. A 16-pixel WebP
  macroblock (and a 4×4…16×16 AVIF transform) never straddles two slices, and the in-loop
  deblocking filter (≤ 3 pixels from a block edge) never reaches a stored voxel, so no slice
  bleeds into its neighbour in Z. The decoder reads the 66² window at offset (7, 7) of each slot.

### 14.3 Compression columns
Five columns, the same for every level. The first three never move a voxel by more than a
guaranteed bound; the last two are perceptual (WebP lossy) and exist to make big levels light.

| id | label (en) | codec | mosaic | max \|error\| | size vs `ll`† |
|---|---|---|---|---|---|
| `ll` | Lossless | `webp-lossless` | grid66 | 0 | 1 |
| `b2` | Visually lossless (±2) | `webp-lossless-lut` | grid66 | 2 | 0.62 – 0.82 |
| `b4` | Near lossless (±4) | `webp-lossless-lut` | grid66 | 4 | 0.50 – 0.69 |
| `q80` | Light (WebP 80) | `webp-lossy-dz` | grid80 | not bounded (PSNR ≈ 36 dB on signal) | 0.35 – 0.61 |
| `q50` | Very light (WebP 50) | `webp-lossy-dz` | grid80 | not bounded (PSNR ≈ 31–33 dB) | 0.22 – 0.40 |

† measured on 1,673 native bricks of three embryos (§14.11).

* **`webp-lossless`** — §13.2 exactly (Pillow `lossless=True, quality=75, method=4`).
* **`webp-lossless-lut`** — the brick stores **bin indices**, losslessly, and the manifest stores
  the column's 256-entry LUT `value_of[index]`. Quantizer with half-width `e` (2 for `b2`, 4 for
  `b4`): 0 is alone in bin 0 (zero stays exactly zero, so empty space and ESS are untouched);
  then bins of `2e+1` consecutive values starting at 1 (`[1, 2e+1]`, `[2e+2, 4e+2]`, …), the last
  one cut at 255; a bin is reconstructed at its centre `s + e` (its last value when cut).
  `index_of[v]` is a fixed table; `|value_of[index_of[v]] − v| ≤ e` for every v. The decoder
  applies `value_of` where it already applies the display LUT (no extra pass).
* **`webp-lossy-dz`** — WebP lossy (VP8) of the grid80 mosaic at quality 80 / 50, `method=6`,
  followed by **one byte τ** (the dead zone) appended to the payload. A lossy codec smears the
  zero background into small values (2–14 % of the zero voxels of our embryos); the encoder,
  which knows the source, picks τ ∈ 0..12 minimising the squared error of the 64³ interior once
  every decoded value ≤ τ is set to 0, and the decoder applies it (again through the LUT it
  already applies: `lut'[v] = v ≤ τ ? 0 : lut[v]`). The image is opaque greyscale; the decoder
  reads R.
* **Why not AVIF** — measured on the same bricks, AVIF 4:0:0 reaches the same size/quality
  trade-off as WebP within a few percent (`avif-q70` ≈ `webp-q80`), encodes 2× slower, has no
  encoder in a browser (the browser executor of §14.10 could not produce it), and decodes no
  faster. **Why not JPEG XL** — not decoded by Chrome and Firefox by default (2026-10). **Why
  not a noise-bounded quantizer (B3D)** — the published uint8 voxels are median-filtered and
  windowed by `2-image_processor.py`; the photon noise is no longer measurable in them (the
  neighbour-difference σ reads structure: 4–99 grey levels), so a bound "within the noise"
  would need the raw counts, which format 5 never reads.
* Decode cost (Chrome 152, 22 cores, the loader's own `createImageBitmap` → OffscreenCanvas
  path, 8 workers): 450–680 bricks/s for every candidate, 6–15 ms per brick on one worker — the
  network, not the decoder, bounds the stream.
* Encode cost (Pillow, one core): `ll` / `b2` / `b4` 85–150 ms a brick, `q80` / `q50`
  170–230 ms a brick.

### 14.4 Manifest v5, indexes, packs
```json
{ "schema": "iribhm-bricks-v5", "version": 5, "formatVersion": 5,
  "channels": C, "brickSize": 64, "apron": 1,
  "levels": [ { "level": 0, "target": "native" | 4096 | …, "dimensions": {"x","y","z"},
                "voxelSize": {"x","y","z"}, "gridSize": {"x","y","z"}, "brickCount": n } … ],
  "columns": [ { "id": "ll", "codec": "webp-lossless", "mosaic": "grid66", "maxError": 0 },
               { "id": "b2", "codec": "webp-lossless-lut", "mosaic": "grid66", "maxError": 2, "lut": [256 ints] },
               { "id": "b4", … "maxError": 4, "lut": […] },
               { "id": "q80", "codec": "webp-lossy-dz", "mosaic": "grid80", "quality": 80, "maxError": null },
               { "id": "q50", … "quality": 50 } ],
  "index": { "ll": { "url": "index/ll.bin", "bytes": N, "sha256": "…" }, "b2": {…}, … },
  "bytes": { "0": { "ll": [per channel], "b2": […], … }, "1": { … }, … },
  "timepoints": null | [ { "path": "t000", "index": { "ll": {…}, … }, "bytes": {…} } … ],
  "histograms": [ … ], "createdAt": "…" }
```
* `index/<column>.bin` — the LBIX layout of §13.3, unchanged (version 1), one file per column
  (a client reads only the columns it shows). `bytes[level][column][channel]` = the summed
  payload lengths — what the quality matrix prints without reading an index.
* Packs `l{k}/{column}/c{c}/pNNNNN.bin`, grouped by super-block as in §13.4. Pack URLs carry
  `?v=<first 12 hex of that column's index sha256>`.
* The `ll` column of level 0 **is** the format-4 level 0: the migration moves those packs
  (`l0/c{c}/p*.bin` → `l0/ll/c{c}/p*.bin`) and keeps their index entries; nothing is re-encoded.

### 14.5 Cut stores (fast slices; every level, lossless)
A cut drawn from 64³ bricks downloads far more than it shows. Simulated on a 5735²×178 embryo
(0.344 × 0.344 × 3 µm), voxels fetched per output pixel of a native cut, by brick shape:

| plane | 64×64×64 (bricks) | 64×64×8 | 32×32×8 | 32×32×4 | 16×16×2 |
|---|---:|---:|---:|---:|---:|
| XY | 64.5 | 8.1 | 8.1 | 4.0 | 2.0 |
| XZ | 8.0 | 7.6 | 3.8 | 3.7 | 1.8 |
| tilted 10° | 65.0 | 9.2 | 8.6 | 4.6 | 2.3 |
| tilted 30° | 59.7 | 10.8 | 8.8 | 5.3 | 2.6 |
| tilted 60° | 39.1 | 10.3 | 7.2 | 5.2 | 2.5 |
| (1,1,1) | 44.5 | 13.2 | 8.8 | 6.4 | 3.1 |

Three re-cut copies, per tree (`live`: under `…/tNNN/`), for every level k:
* **XY** — `planes/` (format 2, level 0, unchanged) and `planes/l{k}/` for k ≥ 1, the §3 layout
  (png-gray8, 512² tiles, one pack per z), manifest `planes/l{k}/manifest.json` with `"level": k`.
  An XY cut = one plane.
* **XZ / YZ** — `planes-xz/l{k}/` and `planes-yz/l{k}/`: one pack per block of 64 consecutive
  rows y (resp. columns x), `bNNNNN.bin`, magic `LPXZ` / `LPYZ`, header `{magic, u16 version 1,
  u16 channels, u16 tilesA, u16 tilesZ, u32 first, u32 count}` then entries in order (row, c,
  tz, ta) `{u64 offset, u32 length}`; tiles = png-gray8 of ≤ 512 (along x, resp. y) × ≤ 512
  (along z), `length 0` iff all zero; manifest `lumen-planes-xz-v1` / `-yz-v1` with
  `rowsPerPack: 64`. An XZ or YZ cut = one row of one pack (one range read per channel).
* **Oblique** — `cuts/l{k}/`: small bricks of `32 × 32 × bz` voxels with
  `bz = 2^round(log₂(32·vxy/vz))` clamped to [1, 32] (about isotropic in µm: 32×32×4 at
  0.344/3 µm, 32×32×8 at 0.43/2.06 µm), **no apron** (a cut samples voxel `floor(value·dim)`,
  never between voxels), lossless WebP mosaic of the bz slices of 32² (`min(bz, 8)` columns),
  stored iff non-zero; `cuts/l{k}/index.bin` (LBIX entries), packs grouped by super-blocks of
  8×8×8 small bricks; manifest `lumen-cuts-v1` with the brick shape. An oblique native cut
  fetches ≈ 4–6 voxels per pixel instead of 40–65.
* Routing of the Studio native pass (`_renderNativeSliceForStudio`): XY → planes, XZ / YZ →
  planes-xz / -yz, anything else (or a warped timelapse) → cuts; bricks only as the fallback of
  a store that is missing or fails. The pass reads the **coarsest level whose voxel is not
  larger than the figure's output pixel** (a native figure reads level 0).

### 14.6 Viewer — the quality matrix
* The quality control becomes a table: one **row per level** (label `512 · 512×512×312`, the
  real dimensions) and one **column per compression** (§14.3). Each cell prints the bytes the
  stream would download (`bytes[level][column]` summed over the channels shown, one timepoint)
  and an estimated time at the throughput the loader measured this session.
* Each row prints the GPU memory of that level (`VolumeViewer.getQualityFootprints`: atlas slots
  with their pitch, R8 / RG8 / RGBA by channel count, halved under the BC display compression).
  Cell colour, from `SVRManager.vramBudget(renderer)`: **green** fits within 75 % of the budget;
  **amber** fits only with the BC display compression, or above 75 %; **red** does not fit — the
  overview stays at the finest level that fits and region-of-interest detail streams the chosen
  cell around the view. A column the browser cannot decode is greyed with its reason.
* Default: column `b2`, the finest green row. The choice is a `{ level target, column }` pair,
  stored in the workspace, the URL and `localStorage['lumen3d.qualityCell']`.
* ROI detail streams the next finer level **in the same column**. *Refine at rest* (on by
  default for `q80` / `q50`): when the camera has rested 1 s, the detail atlas re-streams the
  view in `ll`.
* Compare: `CompareQuality` plans the rows within the host's column (one shared budget, §3.4).

### 14.7 Working copies and exports
* What a user works on (Studio slices, Decompose panels, 3D annotations) is the displayed cell:
  light, decoded once, recoloured on the GPU.
* Every export (3D view image, Studio figure, Decompose panels, Compare figure) offers, every
  time: **Current quality — `<row · column>`** or **Native, lossless**. Native re-renders from
  level 0 `ll`: a Studio figure through the native pass (§14.5); a 3D view through the tiled
  renderer, each tile streaming into the detail atlas the `ll` bricks of the finest level its
  pixel footprint needs before it renders.
* Annotations and measurements are **anchored in micrometres of their frame**, never in screen
  or image pixels: a Studio layer stores its points in µm from the plane's top-left corner along
  the plane's axes; a 3D measurement stores `physicalUm` (it already does). At draw time a layer
  is rasterised at the output pixel size (`p_px = p_µm / pixelSizeUm_out`), so the same document
  lands on the right pixel at any resolution; stroke widths and text are in figure points and
  scale with the output. A document of an older version (image pixels + `pixelSizeUm`) is
  converted on load.
* An exported file records its source cell (`level`, `column`, `maxError`) in its JSON sidecar
  and PNG `tEXt`.

### 14.8 Lossless access for measuring tools (`DataAccess`, `ctx.data`)
`js/core/data-access.js` (`DataAccess`, exposed to plugins as `ctx.data`) is the one door to the
native voxels. Frames: screen pixel → display box [0, 1]³ → physical µm (level-0 voxel size,
origin at the corner of voxel (0, 0, 0)) → level-k voxel (`µm / v_k`) → file.
* `screenToVoxel(x, y)` → `{ um, voxel, onBoundingBox }` through `VolumeViewer.pickVolumePoint`;
  `toVoxel(um, { level })`, `toUm(voxel, { level })`.
* `locate(voxel, channel)` → `{ level0Brick: {bx, by, bz}, pack: {url, offset, length},
  plane: {url, tile, offset, length}, omeZarr: {path, shard, offset, length} | null }` — which
  file, and which bytes of it, hold that lossless voxel.
* `readRegion(box, channels, { level = 0 })` → `{ dims, data: Uint8Array per channel }`, the
  exact lossless voxels (planes for flat boxes, `ll` bricks otherwise), decoded in a worker,
  refused above 512 MiB with `REGION_TOO_LARGE`.
* `valueAt(voxel)` → per-channel lossless values.
* Rule: a measuring tool (intensity profile, histogram of a region, the tracking measurements,
  any plugin that reports a number) reads through `ctx.data`, never the GPU atlas, whatever the
  displayed column.

### 14.9 OME-Zarr v0.5 export (Download Center)
Every format-5 dataset carries `download/<folder>.ome.zarr/` — Zarr v3 / OME-NGFF 0.5:
`multiscales` with axes `c, z, y, x` (`z, y, x` in `micrometer`), one dataset per §14.1 level
(`scale` = its voxel size), `uint8`, **sharding** codec (shards of 1 × 64 × 1024 × 1024, inner
chunks 1 × 64 × 64 × 64, inner codecs `bytes` + `zstd` level 3, index at the end), `omero`
channel names / colours / windows from `metadata.json`. Served like any `download/` file (byte
ranges), so napari / Fiji / Neuroglancer open it by URL. The Download Center lists it as one
entry (total size, *Copy URL*, *Open in napari* hint) and offers `<folder>.ome.zarr.zip` — the
same store in an uncompressed (STORED) zip, written beside it — for a one-file download. It is
also what `DataAccess.locate` names for a voxel.

### 14.10 Migration `m005-matrix` — stages and units
Units, in order (a stage runs once the previous one is complete for that tree and channel):

| stage | unit key | reads | writes |
|---|---|---|---|
| A levels | `t{t}.c{c}.z{z}` | native plane z (`planes/`) | plane z of every level k ≥ 1 (`planes/l{k}/`) |
| B bricks | `t{t}.k{k}.c{c}.z{BZ}.y{BY}.x{BX}` | the level's planes under the super-block (+ apron) | its bricks in every column (level 0: all but `ll`, which is moved) |
| C cuts | `t{t}.k{k}.c{c}.{xz,yz}.b{n}`, `t{t}.k{k}.c{c}.cut.z{}.y{}.x{}` | level planes | `planes-xz`, `planes-yz`, `cuts` packs |
| D OME-Zarr | `t{t}.k{k}.s{shard}` | level planes | one shard |
| finalize | — | — | indexes, manifests, the `ll` level-0 move, the swap of §13.6, version 5 |

* Executors: the **Python server** runs every stage. The **browser** runs A, B and C (lossy WebP
  via `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality: 0.8 | 0.5 })` — not
  byte-identical to Pillow, which is allowed for `q80` / `q50` only; their bricks are checked by
  decoding) and is the executor of a PHP host. D needs zstd: Python (`compression.zstd`, 3.14)
  or the browser through a WebAssembly encoder shipped in `js/vendor/`. The PHP server stores
  units and finalizes; it encodes nothing for m005 (shared hosts kill long requests, §13.9).
* Requests follow §7.2 (one `NetGovernor`, `read_ranges` for every input run).
* A level is resampled from level 0 only (§14.1), so stage A units of different z are
  independent and run on both executors at once.

### 14.11 Benchmark (normative inputs of §14.3)
`tools/bench_brick_codecs.py` (re-runnable): 1,673 native 66³ bricks (2 crops of 6 × 6 bricks ×
every z × every channel) of `Egfl7eGFP-E8-Em13` (10×, 3789²×252, 4 ch), `Egfl7eGFP-Em2-E9`
(25×, deconvolved, 5735²×178, 3 ch), `Egfl7eGFP-E85-Em1` (10×, 1946²×72, 3 ch). Sizes relative
to format 4 (`webp-ll-m4`), per dataset; PSNR on the voxels non-zero in the source or the
result; Dice at the channel's Otsu threshold.

| codec | Em13 | Em2-E9 | E85-Em1 | max err | PSNR (dB) | Dice |
|---|---:|---:|---:|---:|---:|---:|
| deflate9 (raw, lossless) | 1.004 | 1.036 | 1.030 | 0 | ∞ | 1 |
| `b2` (qU2) | 0.677 | 0.617 | 0.820 | 2 | 45.1 | 0.974–0.993 |
| `b4` (qU4) | 0.559 | 0.497 | 0.693 | 4 | 39.8–39.9 | 0.960–0.986 |
| webp-q95 | 0.785 | 0.664 | 1.027 | 13–14 | 44.4–44.9 | 0.983–0.987 |
| webp-q90 | 0.639 | 0.511 | 0.844 | 21–22 | 40.7–41.3 | 0.972–0.981 |
| `q80` | 0.457 | 0.345 | 0.609 | 42–49 | 35.6–36.9 | 0.950–0.964 |
| webp-q70 | 0.371 | 0.275 | 0.496 | 51–57 | 33.0–34.8 | 0.934–0.949 |
| `q50` | 0.300 | 0.220 | 0.402 | 64–71 | 30.9–33.0 | 0.912–0.933 |
| avif-q80 | 0.593 | 0.462 | 0.753 | 21–27 | 39.9–41.3 | 0.970–0.978 |
| avif-q70 | 0.490 | 0.373 | 0.646 | 29–42 | 36.9–38.8 | 0.957–0.967 |
| avif-q50 | 0.281 | 0.212 | 0.398 | 83–92 | 30.0–33.0 | 0.887–0.925 |

The `b2`/`b4` sizes include a 256-byte LUT per brick in the benchmark (stored once per column in
format 5: −0.3 %). Lossless WebP `method=6, quality=100` saves 2 % for 25× the encode time and is
not used. Compression alone gives at most ≈ 3–4×; each row of the matrix gives 4×.

### 14.12 Tests (minimum)
Level ladder and dimensions (N ≤ 256, N = 520, non-square); area-average arithmetic identical in
Python / PHP / JS on random planes (exact integers); quantizer tables and bounds; dead-zone rule;
grid80 round trip; v5 manifest / index validation in `BrickLoader`; the `ll` level-0 move keeps
every byte; cut stores give voxels identical to the bricks; Studio routing per plane kind;
`DataAccess.locate` / `readRegion` against the source; a native-quality export re-places
µm-anchored layers on the exact pixel; the OME-Zarr store read back with zarr-python equals
level k.
