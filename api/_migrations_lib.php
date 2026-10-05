<?php
/**
 * Lumen3D — dataset migrations (PHP twin of dataset_migrations.py)
 * =================================================================
 * Contract: DOCS/dataset-migrations/SPEC.md. Published datasets carry a format
 * version (metadata.json `formatVersion`, absent = 1); LUMEN_MIGRATIONS lists the
 * ordered upgrades; a job journal under uploads/migrations/ records which work units
 * are done, whichever executor did them (the browser posting tiles through unit_put,
 * or this server decoding bricks through unit_run). Journal, lock file and tile store
 * are the Python twin's, byte layout and state machine alike
 * (running → assembling → swapped → removed; failed), so a job started under one
 * backend finishes under the other.
 *
 * m002-planes re-cuts the native level (LOD0) of every brick tree into XY planes:
 * planes/zNNNNN.bin = a 16-byte header, one {u64 offset, u32 length} entry per
 * (channel, tile row, tile column), then greyscale PNG tiles of ≤ 512² pixels.
 *
 * Exactness. A plane pixel must equal what js/core/brick-decode-worker.js produces
 * for that voxel: the RED byte of the decoded lossless WebP mosaic, read where the
 * grid layout puts it — tile (z mod cols, ⌊z / cols⌋) of the brick's mosaic holds
 * plane z, voxel (x, y) at mosaic pixel (tx·64 + x, ty·64 + y) — and 0 outside the
 * decoded picture or for a brick absent from brickToPack (ESS). GD decodes WebP to a
 * truecolor image whose pixel int is (alpha₇ << 24) | (R << 16) | (G << 8) | B, so
 * the voxel is (imagecolorat >> 16) & 0xFF; pack('C*') keeps that low byte.
 *
 * This file is an include (leading underscore ⇒ denied over HTTP by api/.htaccess
 * and router.php); the entry point is api/migrations.php.
 */
declare(strict_types=1);

require_once __DIR__ . '/_upload_lib.php';

const LUMEN_MIG_LATEST          = 2;
const LUMEN_MIG_BRICK           = 64;
const LUMEN_MIG_TILE            = 512;
const LUMEN_MIG_BRICKS_PER_TILE = 8;            // LUMEN_MIG_TILE / LUMEN_MIG_BRICK
const LUMEN_MIG_MAX_BODY        = 33554432;     // 32 MiB unit blob (a real one tops out near 17 MB; PHP holds the body and a copy within memory_limit)
const LUMEN_MIG_MAX_RUN_S       = 20;
const LUMEN_MIG_MAX_BENCH_UNITS = 8;
const LUMEN_MIG_MIN_MEMORY      = 134217728;    // 128 MiB
const LUMEN_MIG_MIN_EXEC_S      = 10;
const LUMEN_MIG_ZLIB_LEVEL      = 6;
// Disk budget of a new job (twin of dataset_migrations.PLANES_SIZE_RATIO / DISK_RESERVE_BYTES):
// the PNG planes weigh ~1.3x the WebP bricks, and the tile store and the assembled packs
// coexist during finalize.
const LUMEN_MIG_PLANES_RATIO    = 1.3;
const LUMEN_MIG_DISK_RESERVE    = 536870912;    // 512 MiB, the import's reserve
const LUMEN_MIG_PLANES_SCHEMA   = 'lumen-planes-v1';
const LUMEN_MIG_PACK_MAGIC      = 'LPLN';
const LUMEN_MIG_PNG_SIG         = "\x89PNG\r\n\x1a\n";

/** Ordered registry — verbatim twin of dataset_migrations.py:MIGRATIONS (SPEC §2). */
const LUMEN_MIGRATIONS = [
    [
        'id' => 'm002-planes', 'from' => 1, 'to' => 2, 'types' => ['3d', 'live'],
        'title' => [
            'en' => 'Plane-major copy of the native level (fast XY cuts in the Studio)',
            'fr' => 'Copie par plans du niveau natif (coupes XY rapides dans le Studio)',
            'es' => 'Copia por planos del nivel nativo (cortes XY rápidos en el Studio)',
            'nl' => 'Kopie per vlak van het native niveau (snelle XY-sneden in de Studio)',
        ],
        'description' => [
            'en' => 'Re-cuts the full-resolution bricks into XY planes stored beside them, so a native XY cut reads one plane instead of a whole 64-slice brick layer. The bricks are untouched; the result is lossless.',
            'fr' => 'Redécoupe les briques en pleine résolution en plans XY rangés à côté d\'elles : une coupe XY native lit un seul plan au lieu d\'une couche entière de 64 tranches. Les briques ne sont pas modifiées ; le résultat est sans perte.',
            'es' => 'Vuelve a cortar los ladrillos a resolución completa en planos XY guardados a su lado: un corte XY nativo lee un solo plano en lugar de una capa entera de 64 cortes. Los ladrillos no se modifican; el resultado no tiene pérdidas.',
            'nl' => 'Snijdt de bricks op volledige resolutie opnieuw in XY-vlakken die ernaast worden bewaard, zodat een native XY-snede één vlak leest in plaats van een hele laag van 64 coupes. De bricks blijven onaangeroerd; het resultaat is verliesvrij.',
        ],
    ],
];

// Tiny lossless WebP (8×8 greyscale ramp, corners 0 and 255) for the capability probe.
const LUMEN_MIG_PROBE_WEBP = 'UklGRigAAABXRUJQVlA4TBsAAAAvB8ABAM1lRP8DZAEmkxlVeqH2JRARE4A7LwUA';
const LUMEN_MIG_PROBE_HEX  = '00254a6f94b9de035b80a5caef14395eb6db00254a6f94b911365b80a5caef146c91b6db00254a6fc7ec11365b80a5ca22476c91b6db00257da2c7ec11365bff';

/** A refusal with a stable reason code (the API's `error`) and an HTTP status. */
final class LumenMigError extends RuntimeException {
    public string $codeName;
    public int $status;
    public ?string $detail;
    public array $extra;
    public function __construct(string $code, int $status = 400, ?string $detail = null, array $extra = []) {
        parent::__construct($detail ?? $code);
        $this->codeName = $code;
        $this->status = $status;
        $this->detail = $detail;
        $this->extra = $extra;
    }
}

// ── Registry helpers ─────────────────────────────────────────────────────────

function lumen_mig_get($id): ?array {
    foreach (LUMEN_MIGRATIONS as $m) if ($m['id'] === $id) return $m;
    return null;
}

function lumen_mig_migration($id): array {
    $m = is_string($id) ? lumen_mig_get($id) : null;
    if ($m === null) throw new LumenMigError('unknown_migration');
    return $m;
}

function lumen_mig_now(): string { return gmdate('Y-m-d\TH:i:s\Z'); }

/** formatVersion of a metadata document: a number ≥ 1 (truncated), anything else ⇒ 1. */
function lumen_mig_format_version($meta): int {
    $v = is_array($meta) ? ($meta['formatVersion'] ?? null) : null;
    if (!is_int($v) && !(is_float($v) && is_finite($v))) return 1;
    $v = (int)$v;
    return $v >= 1 ? $v : 1;
}

// ── Paths, locks, atomic writes ──────────────────────────────────────────────

function lumen_mig_root(): string { return lumen_up_root() . '/migrations'; }

function lumen_mig_job_base(string $type, string $folder, string $mid): string { return "{$type}__{$folder}__{$mid}"; }
function lumen_mig_journal_path(string $type, string $folder, string $mid): string { return lumen_mig_root() . '/' . lumen_mig_job_base($type, $folder, $mid) . '.json'; }
function lumen_mig_store_dir(string $type, string $folder, string $mid): string { return lumen_mig_root() . '/' . lumen_mig_job_base($type, $folder, $mid); }

/** Tile store: <store>/t{t}/z{z}/c{c}.y{ty}.x{tx}.png (z absolute). */
function lumen_mig_tile_path(string $store, int $t, int $z, int $c, int $ty, int $tx): string {
    return "$store/t$t/z$z/c$c.y$ty.x$tx.png";
}

function lumen_mig_ensure_dirs(): void {
    lumen_up_ensure_dirs();                     // uploads/ + its deny-all guard
    admin_make_dir(lumen_mig_root());
}

/**
 * Run $fn under the job's exclusive lock: `<job base>.lock` beside the journal, the
 * file the Python twin locks too.
 */
function lumen_mig_with_job_lock(string $base, callable $fn) {
    lumen_mig_ensure_dirs();
    $lock = @fopen(lumen_mig_root() . "/$base.lock", 'c');
    if ($lock !== false) @flock($lock, LOCK_EX);
    try {
        return $fn();
    } finally {
        if ($lock !== false) { @flock($lock, LOCK_UN); @fclose($lock); }
    }
}

function lumen_mig_rrmdir(string $dir): void { lumen_up_rrmdir($dir); }

function lumen_mig_unit_key(int $t, int $bz, int $c, int $ty, int $tx): string { return "t$t.z$bz.c$c.y$ty.x$tx"; }

/** [t, bz, c, ty, tx] of a unit key; LumenMigError('bad_unit') otherwise. */
function lumen_mig_parse_key($key): array {
    if (!is_string($key) || !preg_match('/^t(\d{1,6})\.z(\d{1,5})\.c(\d{1,3})\.y(\d{1,4})\.x(\d{1,4})$/D', $key, $m)) throw new LumenMigError('bad_unit');
    return [(int)$m[1], (int)$m[2], (int)$m[3], (int)$m[4], (int)$m[5]];
}

// ── Dataset resolution and the plan of a migration ───────────────────────────

/**
 * [type, folder, absolute dir] of a published dataset id '<type>/<folder>'. The dir is
 * derived exactly as datasets.php derives it (admin_safe_dataset: realpath'd, contained
 * in DATA_WEB/<type>), because lumen_with_lock keys its lock on that path string: the
 * version bump and an editor save must take the SAME metadata lock, also when DATA_WEB
 * is reached through a symlink.
 */
function lumen_mig_resolve($id, bool $mustExist = true): array {
    if (!is_string($id) || strpos($id, '/') === false) throw new LumenMigError('bad_dataset');
    [$type, $folder] = explode('/', $id, 2);
    if (!in_array($type, LUMEN_DATASET_TYPES, true) || $folder === '.' || $folder === '..'
        || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $folder)) throw new LumenMigError('bad_dataset');
    $safe = admin_safe_dataset("$type/$folder");
    if ($safe === null) throw new LumenMigError('bad_dataset');
    $dir = $safe[2];
    if ($mustExist && !is_dir($dir)) throw new LumenMigError('no_dataset', 404);
    return [$type, $folder, $dir];
}

/** [free bytes, device id] of the volume holding $path (nearest existing ancestor); nulls when unknown. */
function lumen_mig_volume(string $path): array {
    $probe = $path;
    while (!file_exists($probe) && dirname($probe) !== $probe) $probe = dirname($probe);
    $free = function_exists('disk_free_space') ? @disk_free_space($probe) : false;
    $st = @stat($probe);
    return [is_float($free) || is_int($free) ? (int)$free : null, is_array($st) ? $st['dev'] : null];
}

/** Refuse a new job the disk cannot hold: twin of dataset_migrations._check_disk. */
function lumen_mig_check_disk(array $plan): void {
    $est = (int)(array_sum($plan['unitBytes']) * LUMEN_MIG_PLANES_RATIO);
    [$sf, $sd] = lumen_mig_volume(lumen_mig_root());
    [$df, $dd] = lumen_mig_volume($plan['dir']);
    $checks = ($sd !== null && $sd === $dd) ? [[$sf, 2 * $est]] : [[$sf, $est], [$df, $est]];
    foreach ($checks as [$free, $needed]) {
        if ($free !== null && $needed > max(0, $free - LUMEN_MIG_DISK_RESERVE)) {
            throw new LumenMigError('insufficient_disk', 507, null,
                                    ['neededBytes' => $needed, 'freeBytes' => max(0, $free - LUMEN_MIG_DISK_RESERVE)]);
        }
    }
}

function lumen_mig_int_dim($v): int {
    if (!is_int($v) && !is_float($v)) throw new InvalidArgumentException('dimension');
    $i = (int)$v;
    if ($i != $v || $i < 1 || $i > (1 << 20)) throw new InvalidArgumentException('dimension');
    return $i;
}

/** A pack url resolved under $base, refusing schemes, '..' and empty segments. */
function lumen_mig_safe_rel_file(string $base, $rel): string {
    $s = ltrim(str_replace('\\', '/', (string)$rel), '/');
    $parts = explode('/', $s);
    if ($s === '' || preg_match('/^[a-zA-Z][a-zA-Z0-9+.-]*:/', $s)) throw new InvalidArgumentException("unsafe pack url $rel");
    foreach ($parts as $p) if ($p === '' || $p === '.' || $p === '..') throw new InvalidArgumentException("unsafe pack url $rel");
    return $base . '/' . $s;
}

/**
 * One brick tree: bricks/ of a 3d dataset or bricks/<rel>/ of a timelapse frame, with
 * the LOD0 pack index `index["c:bx:by:bz"] = [file, offset, length]`.
 */
function lumen_mig_build_tree(int $t, string $rel, string $bricksDir, $levels, $channels, $transport, $packing, array $maps = []): array {
    if (!is_array($levels) || !$levels || !is_array($levels[0] ?? null)) throw new InvalidArgumentException('levels');
    $lod0 = $levels[0];
    if (($lod0['level'] ?? 0) !== 0) throw new InvalidArgumentException('levels[0] is not level 0');
    if (($lod0['brickSize'] ?? LUMEN_MIG_BRICK) !== LUMEN_MIG_BRICK) throw new InvalidArgumentException('brickSize');
    $d = is_array($lod0['dimensions'] ?? null) ? $lod0['dimensions'] : [];
    $X = lumen_mig_int_dim($d['x'] ?? null); $Y = lumen_mig_int_dim($d['y'] ?? null); $Z = lumen_mig_int_dim($d['z'] ?? null);
    if (!is_int($channels) && !is_float($channels)) throw new InvalidArgumentException('channels');
    $C = (int)$channels;
    if ($C < 1 || $C > 64) throw new InvalidArgumentException('channels');
    $transport = is_array($transport) ? $transport : [];
    $packing = is_array($packing) ? $packing : [];
    $enc = $transport['encoding'] ?? null;
    if (!in_array($enc, [null, 'webp-lossless', 'raw-u8', 'raw-u8-gzip'], true)) throw new InvalidArgumentException('unsupported encoding');
    if (($enc === null || $enc === 'webp-lossless') && ($packing['mode'] ?? null) !== 'grid') throw new InvalidArgumentException('webp bricks need brickPacking.mode grid');
    $cols = $packing['cols'] ?? null;
    if (!is_int($cols) || $cols < 1) $cols = (int)ceil(LUMEN_MIG_BRICK / ceil(sqrt(LUMEN_MIG_BRICK)));   // the decoder's default: 8
    $tree = ['t' => $t, 'rel' => $rel, 'bricksDir' => $bricksDir, 'X' => $X, 'Y' => $Y, 'Z' => $Z, 'C' => $C,
             'nx' => intdiv($X + 63, 64), 'ny' => intdiv($Y + 63, 64), 'nz' => intdiv($Z + 63, 64),
             'TX' => intdiv($X + 511, 512), 'TY' => intdiv($Y + 511, 512),
             'encoding' => $enc, 'cols' => $cols, 'index' => []];
    $b2p = $transport['brickToPack'] ?? null;
    if (is_string($b2p) && isset($maps[$b2p])) {
        // A map lifted out of the raw manifest by lumen_mig_lift_maps: the LOD0 entries
        // only, [c, bx, by, bz, url, offset, length]. One path string per pack (interned).
        $paths = [];
        foreach ($maps[$b2p] as [$c, $bx, $by, $bz, $url, $off, $len]) {
            if ($c >= $C || $bx >= $tree['nx'] || $by >= $tree['ny'] || $bz >= $tree['nz']) continue;
            if ((!is_int($off) && !is_float($off)) || (!is_int($len) && !is_float($len))) continue;
            $off = (int)$off; $len = (int)$len;
            if ($off < 0 || $len <= 0) continue;
            $key = is_string($url) ? $url : '';
            if (!isset($paths[$key])) $paths[$key] = lumen_mig_safe_rel_file($bricksDir, $url);
            $tree['index']["$c:$bx:$by:$bz"] = [$paths[$key], $off, $len];
        }
    } elseif (is_array($b2p) && $b2p) {
        foreach ($b2p as $key => $entry) {
            if (!is_array($entry) || !preg_match('/^lod0\/c(\d{1,3})\/x(\d{3,})_y(\d{3,})_z(\d{3,})\.webp$/D', ltrim((string)$key, '/'), $m)) continue;
            [$c, $bx, $by, $bz] = [(int)$m[1], (int)$m[2], (int)$m[3], (int)$m[4]];
            if ($c >= $C || $bx >= $tree['nx'] || $by >= $tree['ny'] || $bz >= $tree['nz']) continue;
            $off = $entry['offset'] ?? null; $len = $entry['length'] ?? null;
            if ((!is_int($off) && !is_float($off)) || (!is_int($len) && !is_float($len))) continue;
            $off = (int)$off; $len = (int)$len;
            if ($off < 0 || $len <= 0) continue;
            $tree['index']["$c:$bx:$by:$bz"] = [lumen_mig_safe_rel_file($bricksDir, $entry['url'] ?? null), $off, $len];
        }
    } else {
        // A manifest without a pack index: one file per brick, present when it exists.
        $ext = ['raw-u8' => '.bin', 'raw-u8-gzip' => '.bin.gz'][$enc] ?? '.webp';
        for ($c = 0; $c < $C; $c++) {
            $cdir = "$bricksDir/lod0/c$c";
            if (!is_dir($cdir)) continue;
            foreach (scandir($cdir) ?: [] as $name) {
                if (!preg_match('/^x(\d{3,})_y(\d{3,})_z(\d{3,})' . preg_quote($ext, '/') . '$/D', $name, $m)) continue;
                [$bx, $by, $bz] = [(int)$m[1], (int)$m[2], (int)$m[3]];
                if ($bx < $tree['nx'] && $by < $tree['ny'] && $bz < $tree['nz']) {
                    $tree['index']["$c:$bx:$by:$bz"] = ["$cdir/$name", 0, (int)filesize("$cdir/$name")];
                }
            }
        }
    }
    return $tree;
}

/**
 * Decode a bricks manifest within a shared host's 128 MiB. The lab's largest manifests
 * run to 23 MB of JSON — 80 000 brickToPack entries and as many per-level `chunks`
 * objects — and json_decode turns that into ~140 MB of PHP arrays, a fatal error on
 * every request that plans the dataset (status included). Neither part is needed whole:
 * `chunks` is never read here and only the LOD0 entries of brickToPack are. So each
 * `"chunks": [...]` is replaced by [] and each `"brickToPack": {...}` by a marker string
 * before json_decode, the LOD0 entries of the latter being kept in a compact side table
 * (marker => [[c, bx, by, bz, url, offset, length], …]); lumen_mig_build_tree resolves
 * the marker. A span whose shape is not the expected flat one is left in place and
 * decoded normally, so the result is the Python twin's json.loads for any input.
 * @return array [manifest (array|null), maps]
 */
function lumen_mig_decode_manifest(string $raw): array {
    $str = '"(?:[^"\\\\]|\\\\.)*+"';
    $flatObj = '\{(?:[^{}"]++|' . $str . ')*+\}';
    $out = ''; $pos = 0; $maps = []; $n = strlen($raw);
    while (preg_match('/"(brickToPack|chunks)"\s*+:\s*+([\[{])/', $raw, $m, PREG_OFFSET_CAPTURE, $pos)) {
        $kind = $m[1][0]; $open = $m[2][0];
        $at = $m[2][1] + 1;
        if (($kind === 'chunks') !== ($open === '[')) { $out .= substr($raw, $pos, $at - $pos); $pos = $at; continue; }
        $entries = []; $ok = false; $p = $at;
        while (true) {
            if (!preg_match('/\G\s*+/', $raw, $ws, 0, $p)) break;
            $p += strlen($ws[0]);
            if ($p < $n && $raw[$p] === ($kind === 'chunks' ? ']' : '}')) { $ok = true; $p++; break; }
            if ($kind === 'chunks') {
                // A chunk is a flat object whose values may be arrays of scalars.
                if (!preg_match('/\G\{(?:[^{}\[\]"]++|' . $str . '|\[[^\[\]{}"]*+\])*+\}\s*+,?/', $raw, $e, 0, $p)) break;
                $p += strlen($e[0]);
                continue;
            }
            if (!preg_match('/\G(' . $str . ')\s*+:\s*+(' . $flatObj . ')\s*+,?/', $raw, $e, 0, $p)) break;
            $p += strlen($e[0]);
            $key = json_decode($e[1]);
            if (is_string($key) && preg_match('/^lod0\/c([0-9]{1,3})\/x([0-9]{3,})_y([0-9]{3,})_z([0-9]{3,})\.webp$/D', ltrim($key, '/'), $km)) {
                $v = json_decode($e[2], true);
                if (is_array($v)) $entries[] = [(int)$km[1], (int)$km[2], (int)$km[3], (int)$km[4], $v['url'] ?? null, $v['offset'] ?? null, $v['length'] ?? null];
            }
        }
        if (!$ok) { $out .= substr($raw, $pos, $at - $pos); $pos = $at; continue; }
        $start = $m[2][1];
        if ($kind === 'chunks') {
            $out .= substr($raw, $pos, $start - $pos) . '[]';
        } else {
            $marker = 'lumen-b2p:' . count($maps);
            $maps[$marker] = $entries;
            $out .= substr($raw, $pos, $start - $pos) . '"' . $marker . '"';
        }
        $pos = $p;
        unset($entries);
    }
    $out .= substr($raw, $pos);
    $man = json_decode($out, true);
    return [is_array($man) ? $man : null, $maps];
}

/**
 * The unit plan of a volume dataset: its trees, the bricks manifest sha256, and the
 * NON-EMPTY units in key order (t, layer, channel, tile row, tile column) with the
 * compressed bytes of their bricks. `total` counts every unit, `empty` the units whose
 * bricks are all absent (they are never journaled: their tiles are length 0).
 */
function lumen_mig_plan_for($datasetId): array {
    [$type, $folder, $dir] = lumen_mig_resolve($datasetId);
    if (!in_array($type, LUMEN_VOLUME_DATASET_TYPES, true)) throw new LumenMigError('not_applicable', 409);
    $mpath = "$dir/bricks/manifest.json";
    if (!is_file($mpath)) throw new LumenMigError('no_manifest', 409);
    static $cache = [];
    clearstatcache(true, $mpath);
    $sig = filemtime($mpath) . ':' . filesize($mpath);
    if (isset($cache[$dir]) && $cache[$dir]['sig'] === $sig) return $cache[$dir]['plan'];
    // Across requests: decoding a 23 MB manifest costs ~0.4 s of CPU, paid by every
    // unit_put/unit_run of a job. The plan derived from it is kept beside the journals
    // (uploads/, never served), keyed on the manifest's mtime+size like the per-request
    // cache, and read back without objects (allowed_classes false).
    $diskCache = lumen_mig_root() . '/.plans/' . $type . '__' . $folder . '.ser';
    if (is_file($diskCache)) {
        $hit = @unserialize((string)@file_get_contents($diskCache), ['allowed_classes' => false]);
        if (is_array($hit) && ($hit['sig'] ?? null) === $sig && is_array($hit['plan'] ?? null) && ($hit['plan']['dir'] ?? null) === $dir) {
            $cache = [$dir => ['sig' => $sig, 'plan' => $hit['plan']]];
            return $hit['plan'];
        }
    }
    try {
        $raw = (string)file_get_contents($mpath);
        $sha = hash('sha256', $raw);
        [$man, $maps] = lumen_mig_decode_manifest($raw);
        unset($raw);
        if (!is_array($man)) throw new InvalidArgumentException('manifest is not an object');
        if (($man['brickSize'] ?? LUMEN_MIG_BRICK) !== LUMEN_MIG_BRICK) throw new InvalidArgumentException('brickSize');
        $packing = $man['brickPacking'] ?? null;
        $trees = [];
        $tps = $man['timepoints'] ?? null;
        if ($type === 'live' && is_array($tps) && $tps && array_keys($tps) !== range(0, count($tps) - 1)) {
            $rows = []; $i = 0;
            foreach ($tps as $k => $row) {
                $t = preg_match('/^t(\d{1,6})$/D', (string)$k, $mm) ? (int)$mm[1] : $i;
                $rows[] = [$t, (string)$k, $row];
                $i++;
            }
            usort($rows, fn($a, $b) => $a[0] <=> $b[0]);
            $seen = [];
            foreach ($rows as [$t, $k, $row]) {
                if (!is_array($row)) throw new InvalidArgumentException("timepoint $k");
                $rel = (is_string($row['path'] ?? null) && $row['path'] !== '') ? $row['path'] : $k;
                if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/D', $rel) || isset($seen[$t])) throw new InvalidArgumentException("timepoint path $rel");
                $seen[$t] = true;
                $trees[] = lumen_mig_build_tree($t, $rel, "$dir/bricks/$rel",
                    ($row['levels'] ?? null) ?: ($man['levels'] ?? null),
                    ($row['channels'] ?? null) ?: (($man['channels'] ?? null) ?: 1),
                    is_array($row['brickTransport'] ?? null) ? $row['brickTransport'] : ($man['brickTransport'] ?? null),
                    $packing, $maps);
            }
        } else {
            $trees[] = lumen_mig_build_tree(0, '', "$dir/bricks", $man['levels'] ?? null,
                                            ($man['channels'] ?? null) ?: 1, $man['brickTransport'] ?? null, $packing, $maps);
        }
    } catch (InvalidArgumentException $e) {
        throw new LumenMigError('manifest_invalid', 409, $e->getMessage());
    }
    $byT = []; $unitBytes = []; $total = 0;
    foreach ($trees as $tree) {
        $byT[$tree['t']] = $tree;
        $total += $tree['nz'] * $tree['C'] * $tree['TY'] * $tree['TX'];
        foreach ($tree['index'] as $k => $ref) {
            [$c, $bx, $by, $bz] = array_map('intval', explode(':', $k));
            $u = [$tree['t'], $bz, $c, intdiv($by, 8), intdiv($bx, 8)];
            $uk = lumen_mig_unit_key(...$u);
            if (!isset($unitBytes[$uk])) $unitBytes[$uk] = ['u' => $u, 'bytes' => 0];
            $unitBytes[$uk]['bytes'] += $ref[2];
        }
    }
    uasort($unitBytes, fn($a, $b) => $a['u'] <=> $b['u']);
    $plan = ['dataset' => "$type/$folder", 'type' => $type, 'folder' => $folder, 'dir' => $dir,
             'manifestPath' => $mpath, 'sha' => $sha, 'trees' => $byT,
             'units' => array_map(fn($e) => $e['u'], $unitBytes),      // key => [t,bz,c,ty,tx]
             'unitBytes' => array_map(fn($e) => $e['bytes'], $unitBytes),
             'total' => $total, 'empty' => $total - count($unitBytes)];
    // One plan cached per request: status walks every dataset, and keeping each one
    // (tens of MB for the largest) would add them all up against memory_limit.
    $cache = [$dir => ['sig' => $sig, 'plan' => $plan]];
    if ((is_dir(dirname($diskCache)) || @mkdir(dirname($diskCache), 0755, true))) {
        @lumen_write_file_atomic($diskCache, serialize(['sig' => $sig, 'plan' => $plan]));
    }
    return $plan;
}

/** [tree, w, h, z0, depth] of a unit; LumenMigError('bad_unit') when outside the plan. */
function lumen_mig_unit_geometry(array $plan, array $unit): array {
    [$t, $bz, $c, $ty, $tx] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $bz >= $tree['nz'] || $c >= $tree['C'] || $ty >= $tree['TY'] || $tx >= $tree['TX']) throw new LumenMigError('bad_unit');
    $z0 = $bz * LUMEN_MIG_BRICK;
    return [$tree, min(LUMEN_MIG_TILE, $tree['X'] - $tx * LUMEN_MIG_TILE), min(LUMEN_MIG_TILE, $tree['Y'] - $ty * LUMEN_MIG_TILE),
            $z0, min(LUMEN_MIG_BRICK, $tree['Z'] - $z0)];
}

// ── Planes validity (repair detection) ───────────────────────────────────────

/** SPEC §3.1, keys in the normative order. */
function lumen_mig_planes_manifest(array $tree, string $sha, string $producer, string $createdAt): array {
    return [
        'schema' => LUMEN_MIG_PLANES_SCHEMA,
        'formatVersion' => 2,
        'level' => 0,
        'dimensions' => ['x' => $tree['X'], 'y' => $tree['Y'], 'z' => $tree['Z']],
        'channels' => $tree['C'],
        'tileSize' => LUMEN_MIG_TILE,
        'tiles' => ['x' => $tree['TX'], 'y' => $tree['TY']],
        'codec' => 'png-gray8',
        'packPattern' => 'z{z}.bin',
        'headerBytes' => 16 + 12 * $tree['C'] * $tree['TY'] * $tree['TX'],
        'source' => ['manifestSha256' => $sha],
        'producer' => $producer,
        'createdAt' => $createdAt,
    ];
}

function lumen_mig_tree_planes_dir(string $dsDir, array $tree, string $root = 'planes'): string {
    return $tree['rel'] === '' ? "$dsDir/$root" : "$dsDir/$root/{$tree['rel']}";
}

function lumen_mig_tree_planes_valid(array $plan, array $tree, string $root = 'planes'): bool {
    $d = lumen_mig_tree_planes_dir($plan['dir'], $tree, $root);
    $doc = admin_read_json("$d/manifest.json");
    if ($doc === null) return false;
    $want = lumen_mig_planes_manifest($tree, $plan['sha'], '', '');
    foreach (['schema', 'formatVersion', 'level', 'dimensions', 'channels', 'tileSize', 'tiles', 'codec', 'packPattern', 'headerBytes'] as $k) {
        if (($doc[$k] ?? null) !== $want[$k]) return false;
    }
    if ((is_array($doc['source'] ?? null) ? ($doc['source']['manifestSha256'] ?? null) : null) !== $plan['sha']) return false;
    $names = @scandir($d);
    if ($names === false) return false;
    $names = array_flip($names);
    for ($z = 0; $z < $tree['Z']; $z++) if (!isset($names[sprintf('z%05d.bin', $z)])) return false;
    return true;
}

function lumen_mig_planes_valid(array $plan, string $root = 'planes'): bool {
    foreach ($plan['trees'] as $tree) if (!lumen_mig_tree_planes_valid($plan, $tree, $root)) return false;
    return true;
}

function lumen_mig_repair_needed(array $plan, int $fv, array $m): bool {
    return $fv >= $m['to'] && !lumen_mig_planes_valid($plan);
}

function lumen_mig_applicable(array $plan, int $fv, array $m): bool {
    return in_array($plan['type'], $m['types'], true) && ($fv === $m['from'] || lumen_mig_repair_needed($plan, $fv, $m));
}

// ── Capability probe (SPEC §5) ───────────────────────────────────────────────

function lumen_mig_capabilities(): array {
    static $caps = null;
    if ($caps !== null) return $caps;
    $reasons = [];
    $webp = false;
    if (function_exists('imagecreatefromstring') && function_exists('imagecolorat')) {
        $img = lumen_mig_gd_open((string)base64_decode(LUMEN_MIG_PROBE_WEBP));
        if ($img !== null) {
            try { $webp = bin2hex(lumen_mig_gd_red($img, 8, 8)) === LUMEN_MIG_PROBE_HEX; } catch (Throwable $e) { $webp = false; }
            imagedestroy($img);
        }
    }
    if (!$webp) $reasons[] = 'no_webp_decode';
    $png = false;
    if (function_exists('gzcompress') && function_exists('gzuncompress')) {
        $sample = str_repeat(implode('', array_map('chr', range(0, 255))), 3);
        try { $png = lumen_mig_png_validate(lumen_mig_png_encode($sample, 16, 48), 16, 48) === false; } catch (Throwable $e) { $png = false; }
    }
    if (!$png) $reasons[] = 'no_zlib';
    $mem = lumen_up_ini_bytes((string)ini_get('memory_limit'));   // 0 = unlimited
    if ($mem > 0 && $mem < LUMEN_MIG_MIN_MEMORY) $reasons[] = 'low_memory';
    $met = (int)ini_get('max_execution_time');                    // 0 = unlimited
    if ($met > 0 && $met < LUMEN_MIG_MIN_EXEC_S) $reasons[] = 'exec_time_too_short';
    $caps = [
        'available' => !$reasons, 'reasons' => $reasons, 'webpDecode' => $webp, 'pngEncode' => $png,
        'limits' => ['maxExecutionTime' => $met, 'memoryLimitBytes' => $mem ?: null],
        'backend' => 'php', 'vectorized' => false,
        'maxRunSeconds' => LUMEN_MIG_MAX_RUN_S, 'maxUnitBody' => LUMEN_MIG_MAX_BODY,
    ];
    if (!$webp) $caps['detail'] = function_exists('gd_info') ? 'GD cannot decode lossless WebP exactly' : 'the gd extension is not loaded';
    return $caps;
}

/** A request's time budget in seconds: ≤ 20, and 5 s under max_execution_time. */
function lumen_mig_budget($asked): float {
    $s = is_numeric($asked) ? (float)$asked : (float)LUMEN_MIG_MAX_RUN_S;
    // The floor is a constant so a test can drive the time-bounded paths with a 0 s budget.
    $floor = defined('LUMEN_MIG_BUDGET_FLOOR') ? (float)LUMEN_MIG_BUDGET_FLOOR : 1.0;
    $s = max($floor, min((float)LUMEN_MIG_MAX_RUN_S, $s));
    $met = (int)ini_get('max_execution_time');
    if ($met > 0) $s = max($floor, min($s, (float)($met - 5)));
    return $s;
}

// ── Brick decoding ───────────────────────────────────────────────────────────

/** A truecolor GD image of WebP bytes, or null. */
function lumen_mig_gd_open(string $bytes) {
    if ($bytes === '') return null;
    $img = @imagecreatefromstring($bytes);
    if ($img === false && function_exists('imagecreatefromwebp')) {
        // Some GD builds do not sniff WebP in imagecreatefromstring.
        $tmp = @tempnam(sys_get_temp_dir(), 'lmw');
        if ($tmp !== false) {
            @file_put_contents($tmp, $bytes);
            $img = @imagecreatefromwebp($tmp);
            @unlink($tmp);
        }
    }
    if (!$img) return null;
    if (!imageistruecolor($img)) imagepalettetotruecolor($img);
    return $img;
}

/**
 * The red byte of the top $rows rows of $img as a $width × $rows string; pixels
 * outside the decoded picture are 0 (a truncated mosaic, as in the browser).
 * A translucent pixel is refused: the browser's canvas round-trips it through
 * premultiplied alpha, so no exact copy of the browser's value exists (GD keeps 7
 * alpha bits, so alpha 254 reads as opaque — the pipeline never writes alpha).
 */
function lumen_mig_gd_red($img, int $width, int $rows): string {
    $iw = imagesx($img); $ih = imagesy($img);
    $w = min($width, $iw);
    $pad = $width > $w ? str_repeat("\0", $width - $w) : '';
    $out = '';
    for ($y = 0; $y < $rows; $y++) {
        if ($y >= $ih) { $out .= str_repeat("\0", $width); continue; }
        $a = [];
        for ($x = 0; $x < $w; $x++) $a[] = imagecolorat($img, $x, $y) >> 16;
        if ($a && max($a) > 255) throw new RuntimeException('brick mosaic carries transparency');
        $out .= pack('C*', ...$a) . $pad;
    }
    return $out;
}

/**
 * A decoded brick as [bytes, kind]: kind 'grid' = mosaic rows of width cols·64 (only
 * the rows the layer's depth needs), kind 'raw' = 64³ bytes, x fastest, then y, then z.
 */
function lumen_mig_decode_brick(string $bytes, array $tree, int $depth): array {
    $enc = $tree['encoding'];
    if ($enc === 'raw-u8' || $enc === 'raw-u8-gzip') {
        $data = $enc === 'raw-u8' ? $bytes : @gzdecode($bytes);
        if (!is_string($data) || strlen($data) !== LUMEN_MIG_BRICK ** 3) throw new RuntimeException('raw brick has the wrong length');
        return [$data, 'raw'];
    }
    $img = lumen_mig_gd_open($bytes);
    if ($img === null) throw new RuntimeException('WebP does not decode');
    try {
        $cols = $tree['cols'];
        $rows = (intdiv($depth - 1, $cols) + 1) * LUMEN_MIG_BRICK;
        return [lumen_mig_gd_red($img, $cols * LUMEN_MIG_BRICK, $rows), 'grid'];
    } finally {
        imagedestroy($img);
    }
}

/** Row yy (64 bytes) of slice zz (0..63) of a decoded brick. */
function lumen_mig_brick_row(array $dec, int $cols, int $zz, int $yy): string {
    if ($dec[1] === 'raw') return substr($dec[0], ($zz * LUMEN_MIG_BRICK + $yy) * LUMEN_MIG_BRICK, LUMEN_MIG_BRICK);
    $W = $cols * LUMEN_MIG_BRICK;
    return substr($dec[0], (intdiv($zz, $cols) * LUMEN_MIG_BRICK + $yy) * $W + ($zz % $cols) * LUMEN_MIG_BRICK, LUMEN_MIG_BRICK);
}

// ── PNG (greyscale, 8-bit) ───────────────────────────────────────────────────

function lumen_mig_png_chunk(string $type, string $data): string {
    return pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
}

/**
 * A greyscale PNG of $w × $h pixels (row-major bytes): signature, IHDR, one IDAT
 * (zlib level 6), IEND. Only the decoded pixels are normative (SPEC §3.3); the filter
 * is None on every row, as in the Python and pipeline encoders: on the lab's confocal
 * planes Sub made the tiles larger (4 % over 2264 tiles of five datasets, 70 % on a
 * sparse timelapse — it doubles the entropy of the shot noise that dominates them) and
 * would cost a per-pixel PHP loop (~11 ms per 512² tile, more than the brick decode).
 * No colour chunk: the bytes decode verbatim.
 */
function lumen_mig_png_encode(string $pixels, int $w, int $h): string {
    if ($w < 1 || $h < 1 || strlen($pixels) !== $w * $h) throw new InvalidArgumentException('png: size');
    $rows = [];
    for ($y = 0; $y < $h; $y++) $rows[] = substr($pixels, $y * $w, $w);
    return LUMEN_MIG_PNG_SIG
        . lumen_mig_png_chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 0, 0, 0, 0))
        . lumen_mig_png_chunk('IDAT', gzcompress("\0" . implode("\0", $rows), LUMEN_MIG_ZLIB_LEVEL))
        . lumen_mig_png_chunk('IEND', '');
}

/** [w, h, depth, colourType, compression, filter, interlace] of the first-chunk IHDR, or null. */
function lumen_mig_png_ihdr(string $png): ?array {
    if (strlen($png) < 33 || strncmp($png, LUMEN_MIG_PNG_SIG, 8) !== 0 || substr($png, 8, 8) !== "\x00\x00\x00\x0dIHDR") return null;
    return array_values(unpack('Nw/Nh/Cd/Cct/Ccm/Cf/Ci', substr($png, 16, 13)));
}

/**
 * Full structural check of a png-gray8 tile of the expected size — twin of
 * dataset_migrations.validate_png_gray8: signature, IHDR first (8-bit greyscale, no
 * interlace), only IHDR/IDAT/IEND (no colour-management chunk may reach a browser),
 * every CRC, an IDAT stream inflating to exactly h·(w+1) bytes with filter types
 * 0..4. Returns true when every pixel is zero. Throws InvalidArgumentException.
 *
 * Zero test without unfiltering: with every PNG filter, all-zero pixels filter to
 * all-zero bytes and vice versa (each reconstruction adds the filtered byte to a
 * predictor of zeros), so the filtered rows are tested as they are.
 */
function lumen_mig_png_validate(string $png, int $w, int $h): bool {
    $n = strlen($png);
    if ($n < 8 || strncmp($png, LUMEN_MIG_PNG_SIG, 8) !== 0) throw new InvalidArgumentException('not a PNG (signature)');
    $pos = 8; $kinds = []; $idat = '';
    while ($pos < $n) {
        if ($pos + 12 > $n) throw new InvalidArgumentException('truncated chunk');
        $len = unpack('N', substr($png, $pos, 4))[1];
        $kind = substr($png, $pos + 4, 4);
        if ($len > 0x7FFFFFFF || $pos + 12 + $len > $n) throw new InvalidArgumentException('chunk overruns the file');
        $data = substr($png, $pos + 8, $len);
        if (pack('N', crc32($kind . $data)) !== substr($png, $pos + 8 + $len, 4)) throw new InvalidArgumentException("bad CRC in $kind");
        $kinds[] = $kind;
        $pos += 12 + $len;
        if ($kind === 'IDAT') $idat .= $data;
        elseif ($kind === 'IEND') break;
        elseif ($kind !== 'IHDR') throw new InvalidArgumentException("chunk $kind not allowed");
    }
    if (!$kinds || end($kinds) !== 'IEND') throw new InvalidArgumentException('missing IEND');
    if ($pos !== $n) throw new InvalidArgumentException('bytes after IEND');
    if ($kinds[0] !== 'IHDR' || count(array_keys($kinds, 'IHDR', true)) !== 1) throw new InvalidArgumentException('IHDR is not first');
    $ih = lumen_mig_png_ihdr($png);
    if ($ih === null) throw new InvalidArgumentException('bad IHDR');
    if ($ih[0] !== $w || $ih[1] !== $h) throw new InvalidArgumentException("IHDR {$ih[0]}x{$ih[1]}, expected {$w}x{$h}");
    if ($ih[2] !== 8 || $ih[3] !== 0 || $ih[4] !== 0 || $ih[5] !== 0 || $ih[6] !== 0) throw new InvalidArgumentException('not an 8-bit non-interlaced greyscale PNG');
    if ($idat === '') throw new InvalidArgumentException('no IDAT');
    $expected = $h * ($w + 1);
    // Bounded inflate: a deflate bomb stops one byte past the expected size.
    $raw = @gzuncompress($idat, $expected + 1);
    if (!is_string($raw) || strlen($raw) !== $expected) throw new InvalidArgumentException('IDAT does not inflate to ' . $expected . ' bytes');
    $zero = true;
    $stride = $w + 1;
    for ($y = 0; $y < $h; $y++) {
        if (ord($raw[$y * $stride]) > 4) throw new InvalidArgumentException('bad filter type');
        if ($zero && strspn($raw, "\0", $y * $stride + 1, $w) !== $w) $zero = false;
    }
    return $zero;
}

// ── Server executor: one unit ────────────────────────────────────────────────

/**
 * Read the unit's bricks from their packs (each pack opened once, read in offset
 * order), decode, cut the planes, encode the non-zero tiles.
 * @return array [tiles: [z => png], bytesRead]
 */
function lumen_mig_process_unit(array $plan, array $unit): array {
    [$t, $bz, $c, $ty, $tx] = $unit;
    [$tree, $w, $h, $z0, $depth] = lumen_mig_unit_geometry($plan, $unit);
    $byFile = [];
    for ($j = 0; $j < LUMEN_MIG_BRICKS_PER_TILE; $j++) {
        $by = $ty * LUMEN_MIG_BRICKS_PER_TILE + $j;
        if ($by >= $tree['ny']) break;
        for ($i = 0; $i < LUMEN_MIG_BRICKS_PER_TILE; $i++) {
            $bx = $tx * LUMEN_MIG_BRICKS_PER_TILE + $i;
            if ($bx >= $tree['nx']) break;
            $ref = $tree['index']["$c:$bx:$by:$bz"] ?? null;
            if ($ref !== null) $byFile[$ref[0]][] = [$ref[1], $ref[2], $i, $j];
        }
    }
    $bricks = []; $bytesRead = 0;
    foreach ($byFile as $path => $items) {
        sort($items);
        $fh = @fopen($path, 'rb');
        if ($fh === false) throw new LumenMigError('brick_unreadable', 500, basename($path) . ': missing');
        try {
            foreach ($items as [$off, $len, $i, $j]) {
                $raw = '';
                if (@fseek($fh, $off) === 0) {
                    while (strlen($raw) < $len) {
                        $chunk = fread($fh, $len - strlen($raw));
                        if ($chunk === false || $chunk === '') break;
                        $raw .= $chunk;
                    }
                }
                if (strlen($raw) !== $len) throw new LumenMigError('brick_unreadable', 500, basename($path) . "@$off: short read");
                $bytesRead += $len;
                try {
                    $bricks[($j << 3) | $i] = lumen_mig_decode_brick($raw, $tree, $depth);
                } catch (RuntimeException $e) {
                    throw new LumenMigError('brick_undecodable', 500, sprintf('c%d x%d y%d z%d: %s', $c, $tx * 8 + $i, $ty * 8 + $j, $bz, $e->getMessage()));
                }
            }
        } finally {
            fclose($fh);
        }
    }
    $tiles = [];
    if (!$bricks) return [$tiles, $bytesRead];
    $cols = $tree['cols'];
    $zero64 = str_repeat("\0", LUMEN_MIG_BRICK);
    $nbx = intdiv($w + LUMEN_MIG_BRICK - 1, LUMEN_MIG_BRICK);
    for ($k = 0; $k < $depth; $k++) {
        $rows = [];
        for ($y = 0; $y < $h; $y++) {
            $j = $y >> 6; $yy = $y & 63;
            $row = '';
            for ($i = 0; $i < $nbx; $i++) {
                $dec = $bricks[($j << 3) | $i] ?? null;
                $row .= $dec === null ? $zero64 : lumen_mig_brick_row($dec, $cols, $k, $yy);
            }
            $rows[] = strlen($row) === $w ? $row : substr($row, 0, $w);
        }
        $pix = implode('', $rows);
        if (strspn($pix, "\0") === strlen($pix)) continue;
        $tiles[$z0 + $k] = lumen_mig_png_encode($pix, $w, $h);
    }
    return [$tiles, $bytesRead];
}

// ── Journal and tile store ───────────────────────────────────────────────────

function lumen_mig_load_journal(string $path): ?array {
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    $d = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($d)) throw new LumenMigError('journal_corrupt', 500);
    return $d;
}

function lumen_mig_save_journal(string $path, array $j): void {
    $j['updatedAt'] = lumen_mig_now();
    $j['done'] = array_values($j['done'] ?? []);
    // Maps keyed "0", "1"… would become JSON LISTS (PHP turns numeric string keys into
    // integers), which the Python twin cannot read as {t: sha}.
    foreach (['sourceManifests', 'executors', 'units', 'assembly'] as $k) if (isset($j[$k]) && is_array($j[$k])) $j[$k] = (object)$j[$k];
    $json = json_encode($j, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false || !lumen_write_file_atomic($path, $json)) throw new LumenMigError('journal_write_failed', 500);
}

/** API summary of a journal (twin of dataset_migrations._summary): `done` counts the empty units. */
function lumen_mig_summary(array $j, ?array $plan = null): array {
    $units = is_array($j['units'] ?? null) ? $j['units'] : [];
    $out = [
        'migration' => $j['migration'] ?? null, 'dataset' => $j['dataset'] ?? null, 'state' => $j['state'] ?? null,
        'total' => (int)($units['total'] ?? 0), 'empty' => (int)($units['empty'] ?? 0),
        'done' => count($j['done'] ?? []) + (int)($units['empty'] ?? 0),
        'executors' => $j['executors'] ?? ['browser' => 0, 'server' => 0],
        'createdAt' => $j['createdAt'] ?? null, 'updatedAt' => $j['updatedAt'] ?? null,
    ];
    if (!empty($j['error'])) $out['error'] = $j['error'];
    if (!empty($j['assembly'])) $out['assembly'] = $j['assembly'];
    if ($plan !== null) {
        $done = array_flip($j['done'] ?? []);
        $rest = 0;
        foreach ($plan['unitBytes'] as $k => $b) if (!isset($done[$k])) $rest += $b;
        $out['bytesRemaining'] = $rest;
    }
    return $out;
}

/** Fail the job when the bricks manifest changed since it was planned. */
function lumen_mig_check_source(array $plan, array &$j, string $path): void {
    clearstatcache(true, $plan['manifestPath']);
    $current = @hash_file('sha256', $plan['manifestPath']);
    foreach ((array)($j['sourceManifests'] ?? []) as $sha) {
        if ($sha !== $current) {
            if (($j['state'] ?? null) !== 'failed') {
                $j['state'] = 'failed';
                $j['error'] = 'source_changed';
                lumen_mig_save_journal($path, $j);
            }
            throw new LumenMigError('source_changed', 409);
        }
    }
}

function lumen_mig_open_job($datasetId, $mid): array {
    $m = lumen_mig_migration($mid);
    $plan = lumen_mig_plan_for($datasetId);
    return [$m, $plan, lumen_mig_journal_path($plan['type'], $plan['folder'], $m['id'])];
}

function lumen_mig_read_metadata(string $dir): array {
    $meta = admin_read_json("$dir/metadata.json");
    return is_array($meta) ? $meta : [];
}

/** Create (or resume) a job; its summary and a page of the pending unit keys. */
function lumen_mig_plan($datasetId, $mid, $offset = 0, $limit = 10000): array {
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    $base = lumen_mig_job_base($plan['type'], $plan['folder'], $m['id']);
    $j = lumen_mig_with_job_lock($base, function () use ($m, $plan, $path) {
        $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $m['id']);
        $j = lumen_mig_load_journal($path);
        if ($j !== null && ($j['state'] ?? null) === 'failed') {
            if (($j['error'] ?? null) === 'source_changed') {
                lumen_mig_rrmdir($store);
                $j = null;
            } else {
                // Any other failure: the units already done stay valid (idempotent), resume.
                $j['state'] = 'running';
                unset($j['error']);
                lumen_mig_save_journal($path, $j);
            }
        }
        if ($j !== null) {
            foreach ((array)($j['sourceManifests'] ?? []) as $sha) {
                if ($sha !== $plan['sha']) { lumen_mig_rrmdir($store); $j = null; break; }
            }
        }
        if ($j === null) {
            $fv = lumen_mig_format_version(lumen_mig_read_metadata($plan['dir']));
            if (!lumen_mig_applicable($plan, $fv, $m)) throw new LumenMigError('not_applicable', 409);
            lumen_mig_rrmdir($plan['dir'] . '/.planes-incoming');
            lumen_mig_check_disk($plan);
            $ts = array_keys($plan['trees']);
            sort($ts);
            $src = [];
            foreach ($ts as $t) $src[(string)$t] = $plan['sha'];
            $j = ['migration' => $m['id'], 'dataset' => $plan['dataset'], 'createdAt' => lumen_mig_now(),
                  'sourceManifests' => $src, 'units' => ['total' => $plan['total'], 'empty' => $plan['empty']],
                  'done' => [], 'executors' => ['browser' => 0, 'server' => 0], 'state' => 'running'];
            lumen_mig_save_journal($path, $j);
        }
        return $j;
    });
    $done = array_flip($j['done'] ?? []);
    $pending = [];
    foreach ($plan['units'] as $k => $_u) if (!isset($done[$k])) $pending[] = $k;
    $offset = max(0, (int)$offset);
    $limit = max(1, min(100000, (int)($limit ?: 10000)));
    return array_merge(['ok' => true], lumen_mig_summary($j, $plan),
                       ['pending' => count($pending), 'offset' => $offset, 'units' => array_slice($pending, $offset, $limit)]);
}

/** Replace a unit's tiles in the store: the given planes written, every other plane of its layer removed. */
function lumen_mig_write_unit_tiles(array $plan, string $mid, array $unit, array $tiles): void {
    [$t, $bz, $c, $ty, $tx] = $unit;
    [, , , $z0, $depth] = lumen_mig_unit_geometry($plan, $unit);
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $mid);
    for ($z = $z0; $z < $z0 + $depth; $z++) {
        $p = lumen_mig_tile_path($store, $t, $z, $c, $ty, $tx);
        if (isset($tiles[$z])) {
            if (!lumen_write_file_atomic($p, $tiles[$z])) throw new LumenMigError('tile_write_failed', 500);
        } elseif (is_file($p)) {
            @unlink($p);
        }
    }
}

/** Journal units as done by an executor (counted once per unit). */
function lumen_mig_mark_done(array $plan, array $m, string $path, array $keys, string $executor): array {
    $base = lumen_mig_job_base($plan['type'], $plan['folder'], $m['id']);
    return lumen_mig_with_job_lock($base, function () use ($plan, $path, $keys, $executor) {
        $j = lumen_mig_load_journal($path);
        if ($j === null) throw new LumenMigError('no_job', 404);
        lumen_mig_check_source($plan, $j, $path);
        if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
        $done = $j['done'] ?? [];
        $have = array_flip($done);
        $added = 0;
        foreach ($keys as $k) if (!isset($have[$k])) { $have[$k] = true; $done[] = $k; $added++; }
        $j['done'] = $done;
        $ex = is_array($j['executors'] ?? null) ? $j['executors'] : ['browser' => 0, 'server' => 0];
        $ex[$executor] = (int)($ex[$executor] ?? 0) + $added;
        $j['executors'] = $ex;
        lumen_mig_save_journal($path, $j);
        return $j;
    });
}

/** [[z, png], …] of a unit blob (SPEC §5.1, little-endian u32); LumenMigError('bad_blob'). */
function lumen_mig_parse_blob(string $body): array {
    $n = strlen($body);
    if ($n < 4) throw new LumenMigError('bad_blob');
    $count = unpack('V', substr($body, 0, 4))[1];
    if ($count > LUMEN_MIG_BRICK) throw new LumenMigError('bad_blob', 400, 'too many planes');
    $pos = 4; $out = [];
    for ($i = 0; $i < $count; $i++) {
        if ($pos + 8 > $n) throw new LumenMigError('bad_blob', 400, 'truncated entry');
        $e = unpack('Vz/Vlen', substr($body, $pos, 8));
        $pos += 8;
        if ($pos + $e['len'] > $n) throw new LumenMigError('bad_blob', 400, 'truncated PNG');
        $out[] = [$e['z'], substr($body, $pos, $e['len'])];
        $pos += $e['len'];
    }
    if ($pos !== $n) throw new LumenMigError('bad_blob', 400, 'trailing bytes');
    return $out;
}

/**
 * The request body (≤ 32 MiB) from php://input, read in blocks so an oversized
 * upload is refused before it is buffered; $discard = count the bytes only.
 * @return string|int
 */
function lumen_mig_read_body(bool $discard) {
    $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : -1;
    if ($declared > LUMEN_MIG_MAX_BODY) throw new LumenMigError('body_too_large', 413);
    $in = @fopen('php://input', 'rb');
    if ($in === false) throw new LumenMigError('bad_blob', 400, 'no body');
    $body = ''; $n = 0;
    try {
        while (!feof($in)) {
            $chunk = fread($in, 1048576);
            if ($chunk === false || $chunk === '') break;
            $n += strlen($chunk);
            if ($n > LUMEN_MIG_MAX_BODY) throw new LumenMigError('body_too_large', 413);
            if (!$discard) $body .= $chunk;
        }
    } finally {
        fclose($in);
    }
    // post_max_size discards an oversized body silently: say so instead of "bad blob".
    if ($declared > 0 && $n !== $declared) throw new LumenMigError('body_truncated', 413, "declared $declared, received $n");
    return $discard ? $n : $body;
}

/** Browser executor: store the encoded tiles of one unit (idempotent). $body null = php://input. */
function lumen_mig_unit_put($datasetId, $mid, $key, bool $dry, ?string $body = null): array {
    if ($body !== null && strlen($body) > LUMEN_MIG_MAX_BODY) throw new LumenMigError('body_too_large', 413);
    if ($dry) {
        $bytes = $body !== null ? strlen($body) : lumen_mig_read_body(true);
        $out = ['ok' => true, 'dry' => true, 'bytes' => $bytes];
        try {
            [, , $path] = lumen_mig_open_job($datasetId, $mid);
            $j = lumen_mig_load_journal($path);
            if ($j !== null) { $s = lumen_mig_summary($j); $out['done'] = $s['done']; $out['total'] = $s['total']; }
        } catch (LumenMigError $e) {
        }
        return $out;
    }
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    $unit = lumen_mig_parse_key($key);
    [, $w, $h, $z0, $depth] = lumen_mig_unit_geometry($plan, $unit);
    $ukey = lumen_mig_unit_key(...$unit);
    if (!isset($plan['unitBytes'][$ukey])) throw new LumenMigError('empty_unit', 409);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    $tiles = [];
    foreach (lumen_mig_parse_blob($body ?? lumen_mig_read_body(false)) as [$z, $png]) {
        if ($z < $z0 || $z >= $z0 + $depth || array_key_exists($z, $tiles)) throw new LumenMigError('bad_blob', 400, "plane $z outside the unit's layer");
        try {
            $isZero = lumen_mig_png_validate($png, $w, $h);
        } catch (InvalidArgumentException $e) {
            throw new LumenMigError('bad_png', 400, "z$z: " . $e->getMessage());
        }
        $tiles[$z] = $isZero ? null : $png;
    }
    lumen_mig_write_unit_tiles($plan, $m['id'], $unit, array_filter($tiles, fn($p) => $p !== null));
    $j = lumen_mig_mark_done($plan, $m, $path, [$ukey], 'browser');
    $s = lumen_mig_summary($j);
    return ['ok' => true, 'done' => $s['done'], 'total' => $s['total']];
}

/** Server executor: process pending units for at most ~maxSeconds (at least one). */
function lumen_mig_unit_run($datasetId, $mid, $maxSeconds = LUMEN_MIG_MAX_RUN_S, bool $dry = false): array {
    $t0 = microtime(true);
    $budget = lumen_mig_budget($maxSeconds);
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    $met = (int)ini_get('max_execution_time');
    if ($met > 0) @set_time_limit($met);   // restart the clock here (a no-op where disabled)
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    $processed = []; $bytesRead = 0; $bytesWritten = 0; $slowest = 0.0;
    $done = array_flip($j['done'] ?? []);
    foreach ($plan['units'] as $key => $unit) {
        if (isset($done[$key])) continue;
        $u0 = microtime(true);
        [$tiles, $nread] = lumen_mig_process_unit($plan, $unit);
        $bytesRead += $nread;
        foreach ($tiles as $png) $bytesWritten += strlen($png);
        if (!$dry) {
            lumen_mig_write_unit_tiles($plan, $m['id'], $unit, $tiles);
            $j = lumen_mig_mark_done($plan, $m, $path, [$key], 'server');
        }
        unset($tiles);
        $processed[] = $key;
        $slowest = max($slowest, microtime(true) - $u0);
        if (microtime(true) - $t0 + $slowest > $budget) break;
    }
    $s = lumen_mig_summary($j);
    return ['ok' => true, 'processed' => $processed, 'done' => $s['done'], 'total' => $s['total'],
            'seconds' => round(microtime(true) - $t0, 3), 'bytesRead' => $bytesRead,
            'bytesWritten' => $bytesWritten, 'dry' => $dry];
}

/** Server executor on N sample units spread over the dataset (tiles discarded). */
function lumen_mig_bench($datasetId, $n = 4): array {
    $plan = lumen_mig_plan_for($datasetId);
    $n = is_numeric($n) ? (int)$n : 4;
    $n = max(1, min(LUMEN_MIG_MAX_BENCH_UNITS, $n));
    $units = array_values($plan['units']);
    if (!$units) return ['ok' => true, 'seconds' => 0.0, 'units' => 0, 'bytesRead' => 0, 'bytesWritten' => 0];
    $picks = [];
    for ($k = 0; $k < min($n, count($units)); $k++) {
        $u = $units[intdiv($k * count($units), $n)];
        $picks[lumen_mig_unit_key(...$u)] = $u;
    }
    uasort($picks, fn($a, $b) => $a <=> $b);
    $t0 = microtime(true); $nread = 0; $nwritten = 0;
    foreach ($picks as $u) {
        [$tiles, $r] = lumen_mig_process_unit($plan, $u);
        $nread += $r;
        foreach ($tiles as $png) $nwritten += strlen($png);
    }
    $secs = microtime(true) - $t0;
    return ['ok' => true, 'seconds' => round($secs, 3), 'units' => count($picks), 'bytesRead' => $nread,
            'bytesWritten' => $nwritten, 'secondsPerUnit' => round($secs / count($picks), 4),
            'sample' => array_keys($picks)];
}

// ── Finalize ─────────────────────────────────────────────────────────────────

/** The `producer` of the plane manifests from the executor counts. */
function lumen_mig_producer(array $j): string {
    $b = (int)($j['executors']['browser'] ?? 0);
    $s = (int)($j['executors']['server'] ?? 0);
    if ($b && $s) return 'mixed';
    return $b ? 'migration-browser' : 'migration-server';
}

/**
 * formatVersion = max(current, to), merged into the CURRENT metadata.json under the
 * lock every metadata write of this backend takes (datasets.php save_dataset_meta):
 * an editor save cannot be lost, no other key is touched.
 */
function lumen_mig_bump_metadata(string $dir, int $to): int {
    $path = $dir . DIRECTORY_SEPARATOR . 'metadata.json';
    return lumen_with_lock($path, function () use ($path, $to) {
        if (!is_file($path)) throw new LumenMigError('no_metadata', 409);
        $meta = lumen_read_json_doc($path);
        if (!is_array($meta)) throw new LumenMigError('metadata_invalid', 409);
        $new = max(lumen_mig_format_version($meta), $to);
        if (($meta['formatVersion'] ?? null) !== $new) {
            $meta['formatVersion'] = $new;
            if (!lumen_write_json_doc($path, $meta)) throw new LumenMigError('metadata_write_failed', 500);
            lumen_catalog_invalidate();
        }
        return $new;
    });
}

/** Rename-swap .planes-incoming into planes (old planes aside, then removed); completes an interrupted swap. */
function lumen_mig_swap_planes(string $dsDir): void {
    $incoming = "$dsDir/.planes-incoming"; $live = "$dsDir/planes"; $old = "$dsDir/.planes-old";
    if (is_dir($incoming)) {
        if (file_exists($live)) {
            lumen_mig_rrmdir($old);
            if (!@rename($live, $old)) throw new LumenMigError('swap_failed', 500);
        }
        if (!@rename($incoming, $live)) {
            if (is_dir($old) && !file_exists($live)) @rename($old, $live);
            throw new LumenMigError('swap_failed', 500);
        }
    }
    lumen_mig_rrmdir($old);
}

/**
 * Write the packs of one tree into .planes-incoming; false when the deadline stopped
 * it (packs already written are atomic and are kept for the next call). A missing
 * tile of a done unit is all zero: length 0.
 */
function lumen_mig_assemble_tree(array $plan, array $tree, string $store, string $incoming, string $producer, string $createdAt, ?float $deadline): bool {
    $out = $tree['rel'] === '' ? $incoming : "$incoming/{$tree['rel']}";
    // Deleted (or replaced by a publish) under us: never re-create its folder.
    if (!is_dir($plan['dir'])) throw new LumenMigError('no_dataset', 404);
    if (!admin_make_dir($out)) throw new LumenMigError('assembly_write_failed', 500);
    $present = array_flip(@scandir($out) ?: []);
    $C = $tree['C']; $TX = $tree['TX']; $TY = $tree['TY'];
    $hb = 16 + 12 * $C * $TY * $TX;
    for ($z = 0; $z < $tree['Z']; $z++) {
        $name = sprintf('z%05d.bin', $z);
        if (isset($present[$name])) continue;
        if ($deadline !== null && microtime(true) > $deadline) return false;
        if (!is_dir($out)) throw new LumenMigError('no_dataset', 404);
        $bz = intdiv($z, LUMEN_MIG_BRICK);
        $head = LUMEN_MIG_PACK_MAGIC . pack('vvvvV', 1, $C, $TX, $TY, $z);
        $payloads = []; $off = $hb;
        for ($c = 0; $c < $C; $c++) for ($ty = 0; $ty < $TY; $ty++) {
            $h = min(LUMEN_MIG_TILE, $tree['Y'] - $ty * LUMEN_MIG_TILE);
            for ($tx = 0; $tx < $TX; $tx++) {
                $w = min(LUMEN_MIG_TILE, $tree['X'] - $tx * LUMEN_MIG_TILE);
                $payload = '';
                if (isset($plan['unitBytes'][lumen_mig_unit_key($tree['t'], $bz, $c, $ty, $tx)])) {
                    $p = lumen_mig_tile_path($store, $tree['t'], $z, $c, $ty, $tx);
                    if (is_file($p)) {
                        $payload = (string)@file_get_contents($p);
                        if ($payload !== '' && lumen_mig_png_ihdr($payload) !== [$w, $h, 8, 0, 0, 0, 0]) {
                            throw new LumenMigError('bad_tile', 500, basename($p) . " z$z: IHDR");
                        }
                    }
                }
                $len = strlen($payload);
                $head .= pack('PV', $len ? $off : 0, $len);
                if ($len) { $payloads[] = $payload; $off += $len; }
            }
        }
        if (!lumen_write_file_atomic("$out/$name", $head . implode('', $payloads))) throw new LumenMigError('assembly_write_failed', 500);
    }
    $json = json_encode(lumen_mig_planes_manifest($tree, $plan['sha'], $producer, $createdAt), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false || !lumen_write_file_atomic("$out/manifest.json", $json)) throw new LumenMigError('assembly_write_failed', 500);
    return true;
}

/**
 * Assemble, validate, swap, bump (SPEC §5.2). Re-entrant at every step: a crash or the
 * request budget leaves a state the next call completes. Always time-bounded here (a
 * shared host kills a request at max_execution_time): `complete: false` + `assembly`
 * means "call again".
 */
function lumen_mig_finalize($datasetId, $mid, $maxSeconds = null): array {
    $deadline = microtime(true) + lumen_mig_budget($maxSeconds ?? LUMEN_MIG_MAX_RUN_S);
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    $met = (int)ini_get('max_execution_time');
    if ($met > 0) @set_time_limit($met);
    $base = lumen_mig_job_base($plan['type'], $plan['folder'], $m['id']);
    return lumen_mig_with_job_lock($base, function () use ($m, $plan, $path, $deadline) {
        $j = lumen_mig_load_journal($path);
        if ($j === null) {
            // Nothing journaled: the structure may already be in place (a crash after the
            // swap that also lost the journal, a pipeline-made tree) — bump only then.
            if (in_array($plan['type'], $m['types'], true) && lumen_mig_planes_valid($plan)) {
                return ['ok' => true, 'formatVersion' => lumen_mig_bump_metadata($plan['dir'], $m['to'])];
            }
            throw new LumenMigError('no_job', 404);
        }
        $state = $j['state'] ?? null;
        if ($state === 'running' || $state === 'assembling') lumen_mig_check_source($plan, $j, $path);
        if ($state === 'running') {
            $done = array_flip($j['done'] ?? []);
            $missing = 0;
            foreach ($plan['units'] as $k => $_u) if (!isset($done[$k])) $missing++;
            if ($missing) throw new LumenMigError('units_pending', 409, "$missing unit(s) not done");
            lumen_mig_rrmdir($plan['dir'] . '/.planes-incoming');
            $j['state'] = 'assembling';
            $j['producer'] = lumen_mig_producer($j);
            $j['assembledAt'] = lumen_mig_now();
            lumen_mig_save_journal($path, $j);
            $state = 'assembling';
        }
        if ($state === 'assembling') {
            $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $m['id']);
            $incoming = $plan['dir'] . '/.planes-incoming';
            $planesTotal = 0;
            foreach ($plan['trees'] as $tree) $planesTotal += $tree['Z'];
            $ts = array_keys($plan['trees']);
            sort($ts);
            foreach ($ts as $t) {
                if (!lumen_mig_assemble_tree($plan, $plan['trees'][$t], $store, $incoming,
                                             $j['producer'] ?? lumen_mig_producer($j), $j['assembledAt'] ?? lumen_mig_now(), $deadline)) {
                    $written = 0;
                    foreach ($plan['trees'] as $tr) {
                        $d = $tr['rel'] === '' ? $incoming : "$incoming/{$tr['rel']}";
                        foreach (@scandir($d) ?: [] as $nm) if (substr($nm, -4) === '.bin') $written++;
                    }
                    $j['assembly'] = ['planes' => $planesTotal, 'written' => $written];
                    lumen_mig_save_journal($path, $j);
                    return ['ok' => true, 'complete' => false, 'assembly' => $j['assembly']];
                }
            }
            if (!lumen_mig_planes_valid($plan, '.planes-incoming')) throw new LumenMigError('assembly_invalid', 500);
            // The assembly may have spanned many requests: a re-publish of the dataset in
            // the meantime must not get these planes nor a version bump.
            lumen_mig_check_source($plan, $j, $path);
            lumen_mig_swap_planes($plan['dir']);
            $j['state'] = 'swapped';
            unset($j['assembly']);
            lumen_mig_save_journal($path, $j);
            $state = 'swapped';
        }
        if ($state === 'swapped') {
            lumen_mig_swap_planes($plan['dir']);   // completes a swap a crash interrupted
            if (!lumen_mig_planes_valid($plan)) {
                $j['state'] = 'failed';
                $j['error'] = 'assembly_invalid';
                lumen_mig_save_journal($path, $j);
                throw new LumenMigError('assembly_invalid', 500);
            }
            $fv = lumen_mig_bump_metadata($plan['dir'], $m['to']);
            lumen_mig_rrmdir(lumen_mig_store_dir($plan['type'], $plan['folder'], $m['id']));
            @unlink($path);
            return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
        }
        throw new LumenMigError('job_failed', 409, (string)($j['error'] ?? $state));
    });
}

function lumen_mig_cancel($datasetId, $mid): array {
    $m = lumen_mig_migration($mid);
    // A dataset deleted mid-job must still let the operator drop its journal and tiles.
    [$type, $folder, $dir] = lumen_mig_resolve($datasetId, false);
    $base = lumen_mig_job_base($type, $folder, $m['id']);
    lumen_mig_with_job_lock($base, function () use ($type, $folder, $dir, $m) {
        $path = lumen_mig_journal_path($type, $folder, $m['id']);
        $j = null;
        try { $j = lumen_mig_load_journal($path); } catch (LumenMigError $e) { }
        // The new planes are live already: finishing is the only consistent exit.
        if ($j !== null && ($j['state'] ?? null) === 'swapped') throw new LumenMigError('finalize_in_progress', 409);
        lumen_mig_rrmdir(lumen_mig_store_dir($type, $folder, $m['id']));
        lumen_mig_rrmdir("$dir/.planes-incoming");
        @unlink($path);
        return null;
    });
    @unlink(lumen_mig_root() . "/$base.lock");
    return ['ok' => true];
}

// ── Status ───────────────────────────────────────────────────────────────────

function lumen_mig_dataset_status(string $type, string $folder, string $dir): array {
    $meta = lumen_mig_read_metadata($dir);
    $fv = lumen_mig_format_version($meta);
    $row = ['id' => "$type/$folder", 'type' => $type, 'folder' => $folder,
            'name' => (is_string($meta['name'] ?? null) && $meta['name'] !== '') ? $meta['name'] : $folder,
            'formatVersion' => $fv, 'pending' => [], 'repair' => false, 'trees' => 0, 'job' => null,
            'estimate' => ['units' => 0, 'bytes' => 0]];
    if (!in_array($type, LUMEN_VOLUME_DATASET_TYPES, true)) return $row;
    try {
        $plan = lumen_mig_plan_for($row['id']);
    } catch (LumenMigError $e) {
        $row['problem'] = $e->codeName;
        if ($e->detail !== null) $row['problemDetail'] = substr($e->detail, 0, 300);
        return $row;
    }
    $row['trees'] = count($plan['trees']);
    $jobs = []; $jobDone = null;
    foreach (LUMEN_MIGRATIONS as $m) {
        if (!in_array($plan['type'], $m['types'], true)) continue;
        try {
            $j = lumen_mig_load_journal(lumen_mig_journal_path($type, $folder, $m['id']));
        } catch (LumenMigError $e) {
            $j = ['migration' => $m['id'], 'state' => 'failed', 'error' => 'journal_corrupt'];
        }
        $repair = lumen_mig_repair_needed($plan, $fv, $m);
        if ($m['from'] >= $fv || $repair) {
            $row['pending'][] = $m['id'];
            $row['repair'] = $row['repair'] || $repair;
        }
        if ($j !== null) {
            $jobs[] = lumen_mig_summary($j, $plan);
            if ($jobDone === null) $jobDone = array_flip($j['done'] ?? []);
        }
    }
    if ($jobs) $row['job'] = $jobs[0];
    if ($row['pending']) {
        $done = $jobDone ?? [];
        $units = 0; $bytes = 0; $all = 0;
        foreach ($plan['unitBytes'] as $k => $b) {
            $all += $b;
            if (!isset($done[$k])) { $units++; $bytes += $b; }
        }
        $row['estimate'] = ['units' => $units, 'bytes' => $bytes, 'unitsTotal' => count($plan['unitBytes']), 'bytesTotal' => $all];
    }
    return $row;
}

function lumen_mig_status(): array {
    $datasets = [];
    foreach (['3d', '2d', 'live'] as $type) {
        $base = data_web() . '/' . $type;
        if (!is_dir($base)) continue;
        $names = array_values(array_filter(@scandir($base) ?: [], fn($n) => $n !== '' && $n[0] !== '.'
            && preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $n) && is_dir("$base/$n")));
        usort($names, fn($a, $b) => strcmp(strtolower($a), strtolower($b)));
        foreach ($names as $folder) $datasets[] = lumen_mig_dataset_status($type, $folder, "$base/$folder");
    }
    return ['ok' => true, 'latest' => LUMEN_MIG_LATEST, 'migrations' => LUMEN_MIGRATIONS,
            'datasets' => $datasets, 'server' => lumen_mig_capabilities()];
}

// ── Dispatch (api/migrations.php) ────────────────────────────────────────────

const LUMEN_MIG_WRITE_ACTIONS = ['plan', 'unit_put', 'unit_run', 'finalize', 'cancel', 'bench'];

/**
 * One API call → [HTTP status, JSON payload]; twin of dataset_migrations.handle.
 * Authentication, CSRF and the method are the entry point's job. $raw: the unit_put
 * body when already read (tests), null = stream php://input.
 */
function lumen_mig_handle(string $action, array $params, array $body, ?string $raw = null): array {
    try {
        switch ($action) {
            case 'status':
                return [200, lumen_mig_status()];
            case 'plan':
                return [200, lumen_mig_plan($body['dataset'] ?? null, $body['migration'] ?? null, $body['offset'] ?? 0, $body['limit'] ?? 10000)];
            case 'unit_put':
                return [200, lumen_mig_unit_put($params['dataset'] ?? null, $params['migration'] ?? null, $params['unit'] ?? null,
                                                in_array((string)($params['dry'] ?? '0'), ['1', 'true'], true), $raw)];
            case 'unit_run':
            case 'bench':
                $caps = lumen_mig_capabilities();
                if (!$caps['available']) throw new LumenMigError('server_unavailable', 409, implode(',', $caps['reasons']));
                if ($action === 'bench') return [200, lumen_mig_bench($body['dataset'] ?? null, $body['units'] ?? 4)];
                return [200, lumen_mig_unit_run($body['dataset'] ?? null, $body['migration'] ?? null,
                                                $body['maxSeconds'] ?? LUMEN_MIG_MAX_RUN_S, !empty($body['dry']))];
            case 'finalize':
                return [200, lumen_mig_finalize($body['dataset'] ?? null, $body['migration'] ?? null, $body['maxSeconds'] ?? null)];
            case 'cancel':
                return [200, lumen_mig_cancel($body['dataset'] ?? null, $body['migration'] ?? null)];
        }
        return [400, ['error' => 'unknown_action']];
    } catch (LumenMigError $e) {
        $payload = ['error' => $e->codeName] + $e->extra;
        if ($e->detail !== null && $e->detail !== $e->codeName) $payload['detail'] = substr($e->detail, 0, 500);
        return [$e->status, $payload];
    }
}
