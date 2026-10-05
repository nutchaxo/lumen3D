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
* Switching executor mid-job is allowed (same journal).

## 7. Benchmark

Button in the tab, on a chosen dataset (default: the smallest pending one):
* Browser: N sample units (default 4, non-empty), real downloads + decode + encode + upload
  with `dry=1`; reports seconds per unit and bytes in/out.
* Server: `bench` with the same N units.
* Result: seconds per unit for each available executor and an estimated total duration per
  pending dataset and for all of them. Informative only — the operator picks either
  executor freely (B only when `server.available`).

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
* Server capability panel (available or the reasons it is not), executor selector (A / B,
  B disabled with the reason when unavailable), Benchmark button and results.
* Actions: update one dataset, update all (a queue: datasets one after another, each
  dataset's migrations in order), pause/resume, cancel a job, retry a failed one.
* Precise progress (% units, MB in/out, ETA), log of finished updates. Leaving the tab with a
  job running asks for confirmation (it pauses the job).
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
