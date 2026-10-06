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
| `finalize` | POST | `{ dataset, migration, maxSeconds? }` | `{ ok, complete, formatVersion?, assembly:{planes, written} }` — assembles, validates, swaps, bumps; resumable: call again until `complete:true` |
| `cancel` | POST | `{ dataset, migration }` | deletes journal + tile store |
| `bench` | POST | `{ dataset, units: N (≤ 8) }` | server executor on N sample units (dry: tiles discarded) → `{ seconds, units, bytesRead, bytesWritten }` |
| `speedtest` | POST | `{ maxSeconds (≤ 3) }` | server side of the speed test (§7): test blocks back to back until the next one would end past `maxSeconds` (≥ 1 block) → `{ blocks, seconds, bytesRead, bytesWritten }`; needs m002's capability (409 `server_unavailable` otherwise) |
| `speedtest_put` | POST (binary) | body = one converted test batch (≤ 4 MiB) | `{ ok, bytes }` — read and dropped |
| `speedtest_sample` | GET (binary answer) | query `n` (1..8) | the test brick repeated n times (one download per browser batch) |
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
* Browser: the worker pool at its normal concurrency (workers × slots), in batches of 8 blocks:
  one `speedtest_sample?n=8` download, decode + encode of each block in a worker, one upload of
  the 8 tiles to `speedtest_put` — the bytes a real browser unit moves, in two requests per batch,
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
* at most 6 requests in flight, a token bucket of 6 starting at 10 requests/s, never above 16/s;
* a request without HTTP answer, a 429 or a 503 halves the rate (floor 0.5/s) and holds every
  new request for a cooldown (5 s, doubling to 60 s while failures go on); each answer raises the
  rate by 0.2/s. The tab says when requests are being held.
Measured on the synthetic pair of the tests (3 400 requests): 8 requests/s on average, 20 in the
busiest second, against well over 40/s and tens of connections without it.

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
sha256 (their voxels are LOD0, unchanged), bump to 4. Old `bricks.v2-old/` deleted after the bump.

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
