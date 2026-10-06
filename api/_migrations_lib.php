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
require_once __DIR__ . '/_migrations_formats.php';

const LUMEN_MIG_LATEST          = 4;
const LUMEN_MIG_BRICK           = 64;
const LUMEN_MIG_TILE            = 512;
const LUMEN_MIG_BRICKS_PER_TILE = 8;            // LUMEN_MIG_TILE / LUMEN_MIG_BRICK
const LUMEN_MIG_MAX_BODY        = 33554432;     // 32 MiB unit blob (a real one tops out near 17 MB; PHP holds the body and a copy within memory_limit)
const LUMEN_MIG_MAX_RUN_S       = 20;
const LUMEN_MIG_MAX_BENCH_UNITS = 8;
const LUMEN_MIG_SPEEDTEST_MAX_S  = 3.0;
const LUMEN_MIG_SPEEDTEST_PUT_MAX = 4194304;
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

/** Ordered registry — verbatim twin of dataset_migrations.py:MIGRATIONS (SPEC §2, §11). */
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
    [
        'id' => 'm003-layer-mips', 'from' => 2, 'to' => 3, 'types' => ['3d', 'live'],
        'title' => [
            'en' => 'Maximum projections of each brick layer (fast whole-stack z-stack figures)',
            'fr' => 'Projections maximales de chaque couche de briques (figures z-stack de toute la pile rapides)',
            'es' => 'Proyecciones máximas de cada capa de ladrillos (figuras z-stack de toda la pila rápidas)',
            'nl' => 'Maximumprojecties van elke brick-laag (snelle z-stackfiguren over de hele stapel)',
        ],
        'description' => [
            'en' => 'Stores, for every 64-plane layer of the native level and every channel, the per-pixel maximum of its planes, so a maximum projection of a thick slab reads one picture per layer instead of 64 planes. Derived from the planes; lossless.',
            'fr' => 'Range, pour chaque couche de 64 plans du niveau natif et chaque canal, le maximum pixel par pixel de ses plans : une projection maximale d\'une tranche épaisse lit une image par couche au lieu de 64 plans. Dérivé des plans ; sans perte.',
            'es' => 'Guarda, para cada capa de 64 planos del nivel nativo y cada canal, el máximo píxel a píxel de sus planos: una proyección máxima de un bloque grueso lee una imagen por capa en lugar de 64 planos. Derivado de los planos; sin pérdidas.',
            'nl' => 'Bewaart voor elke laag van 64 vlakken van het native niveau en elk kanaal het maximum per pixel van zijn vlakken, zodat een maximumprojectie van een dikke plak één beeld per laag leest in plaats van 64 vlakken. Afgeleid van de vlakken; verliesvrij.',
        ],
    ],
    [
        'id' => 'm004-bricks-v3', 'from' => 3, 'to' => 4, 'types' => ['3d', 'live'],
        'title' => [
            'en' => 'Brick pyramid v3: halved in Z too, 1-voxel border, binary index',
            'fr' => 'Pyramide de briques v3 : réduite aussi en Z, bordure d\'un voxel, index binaire',
            'es' => 'Pirámide de ladrillos v3: reducida también en Z, borde de un vóxel, índice binario',
            'nl' => 'Brick-piramide v3: ook in Z gehalveerd, rand van één voxel, binaire index',
        ],
        'description' => [
            'en' => 'Rebuilds the brick tree: the native level is kept voxel for voxel, every coarser level halves Z as well once the voxels are close to isotropic, every brick carries a 1-voxel border (seamless filtering across bricks) and a compact binary index replaces the large JSON manifest. Lossless.',
            'fr' => 'Reconstruit l\'arbre de briques : le niveau natif est conservé voxel pour voxel, chaque niveau plus grossier réduit aussi Z dès que les voxels sont presque isotropes, chaque brique porte une bordure d\'un voxel (filtrage sans couture entre briques) et un index binaire compact remplace le gros manifeste JSON. Sans perte.',
            'es' => 'Reconstruye el árbol de ladrillos: el nivel nativo se conserva vóxel a vóxel, cada nivel más grueso reduce también Z cuando los vóxeles son casi isótropos, cada ladrillo lleva un borde de un vóxel (filtrado sin costuras entre ladrillos) y un índice binario compacto sustituye al gran manifiesto JSON. Sin pérdidas.',
            'nl' => 'Bouwt de brick-boom opnieuw op: het native niveau blijft voxel voor voxel behouden, elk grover niveau halveert ook Z zodra de voxels bijna isotroop zijn, elke brick heeft een rand van één voxel (naadloze filtering tussen bricks) en een compacte binaire index vervangt het grote JSON-manifest. Verliesvrij.',
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
    return [is_array($man) ? $man : null, $maps, $out];
}

/**
 * What format 4's manifest carries over from the v2 one, kept as JSON TEXT (re-decoded
 * as objects at assembly) so an empty {} inside a histogram survives PHP's arrays:
 * ['histograms' => json|null, 'dataset' => string|null, 'tph' => [tree path => json]].
 */
function lumen_mig_v2_carry(string $reduced): array {
    $doc = json_decode($reduced);
    $out = ['histograms' => null, 'dataset' => null, 'tph' => []];
    if (!($doc instanceof stdClass)) return $out;
    if (isset($doc->histograms) && is_array($doc->histograms)) $out['histograms'] = json_encode($doc->histograms, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if (isset($doc->dataset) && is_string($doc->dataset)) $out['dataset'] = $doc->dataset;
    if (isset($doc->timepoints) && $doc->timepoints instanceof stdClass) {
        foreach (get_object_vars($doc->timepoints) as $key => $row) {
            if ($row instanceof stdClass && isset($row->histograms) && is_array($row->histograms)) {
                $rel = (isset($row->path) && is_string($row->path) && $row->path !== '') ? $row->path : (string)$key;
                $out['tph'][$rel] = json_encode($row->histograms, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
            }
        }
    }
    return $out;
}

/** A voxel size {x, y, z} of positive finite numbers as [vx, vy, vz], else null (twin of _voxel_triplet). */
function lumen_mig_voxel_triplet($v): ?array {
    if (!is_array($v)) return null;
    $out = [];
    foreach (['x', 'y', 'z'] as $a) {
        $x = $v[$a] ?? null;
        if (is_string($x) && is_numeric(trim($x))) $x = (float)trim($x);
        if (!is_int($x) && !is_float($x)) return null;
        $x = (float)$x;
        if (!($x > 0) || !is_finite($x)) return null;
        $out[] = $x;
    }
    return $out;
}

/** LOD0 voxel size driving the v3 Z rule: v3 levels[0].voxelSize, the manifest's voxelSize, metadata voxel_size, else 1 µm. */
function lumen_mig_manifest_voxel(array $man, string $dir): array {
    if (($man['schema'] ?? null) === LUMEN_V3_SCHEMA && is_array($man['levels'][0] ?? null)) {
        $v = lumen_mig_voxel_triplet($man['levels'][0]['voxelSize'] ?? null);
        if ($v) return $v;
    }
    $v = lumen_mig_voxel_triplet($man['voxelSize'] ?? null);
    if ($v) return $v;
    $meta = admin_read_json("$dir/metadata.json");
    $v = lumen_mig_voxel_triplet(is_array($meta) ? ($meta['voxel_size'] ?? null) : null);
    return $v ?: [1.0, 1.0, 1.0];
}

/**
 * Trees of a format-4 manifest (SPEC §13.3; twin of _build_v3_trees). Each tree's LOD0
 * index.bin entries become its `index`, so m002 (a repair on a v4 dataset) reads the v3
 * bricks' interiors. Returns [trees, problem]: problem = the first structural fault.
 */
function lumen_mig_build_v3_trees(string $type, string $bricksRoot, array $man): array {
    $levels = $man['levels'] ?? null;
    if (!is_array($levels) || !$levels || array_keys($levels) !== range(0, count($levels) - 1)) throw new InvalidArgumentException('levels');
    foreach ($levels as $L) if (!is_array($L)) throw new InvalidArgumentException('levels');
    if (($man['brickSize'] ?? LUMEN_MIG_BRICK) !== LUMEN_MIG_BRICK || ($man['apron'] ?? null) !== LUMEN_V3_APRON) throw new InvalidArgumentException('brickSize/apron');
    $p = is_array($man['brickPacking'] ?? null) ? $man['brickPacking'] : [];
    if (($p['mode'] ?? null) !== 'grid' || ($p['cols'] ?? null) !== LUMEN_V3_COLS || ($p['rows'] ?? null) !== LUMEN_V3_ROWS || ($p['slice'] ?? null) !== LUMEN_V3_SLICE) throw new InvalidArgumentException('brickPacking');
    $C = $man['channels'] ?? null;
    if (!is_int($C) || $C < 1 || $C > 64) throw new InvalidArgumentException('channels');
    $grids = [];
    foreach ($levels as $k => $L) {
        if (($L['level'] ?? null) !== $k) throw new InvalidArgumentException("level $k out of order");
        $d = is_array($L['dimensions'] ?? null) ? $L['dimensions'] : [];
        $g = is_array($L['gridSize'] ?? null) ? $L['gridSize'] : [];
        $dims = [lumen_mig_int_dim($d['x'] ?? null), lumen_mig_int_dim($d['y'] ?? null), lumen_mig_int_dim($d['z'] ?? null)];
        $grid = [lumen_mig_int_dim($g['x'] ?? null), lumen_mig_int_dim($g['y'] ?? null), lumen_mig_int_dim($g['z'] ?? null)];
        if ($grid !== array_map(fn($n) => intdiv($n + 63, 64), $dims)) throw new InvalidArgumentException("level $k gridSize");
        $grids[] = $grid;
    }
    $d0 = $levels[0]['dimensions'];
    [$X, $Y, $Z] = [lumen_mig_int_dim($d0['x']), lumen_mig_int_dim($d0['y']), lumen_mig_int_dim($d0['z'])];
    $tps = $man['timepoints'] ?? null;
    $refs = []; $rels = [];
    if ($type === 'live' && is_array($tps) && $tps && array_keys($tps) === range(0, count($tps) - 1)) {
        foreach ($tps as $row) {
            if (!is_array($row)) throw new InvalidArgumentException('timepoint row');
            $rel = is_scalar($row['path'] ?? null) ? (string)$row['path'] : '';
            if (!preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/D', $rel)) throw new InvalidArgumentException("timepoint path $rel");
            $rels[] = $rel;
            $ref = $row['index'] ?? null;
            if (is_array($ref) && ($ref['url'] ?? null) === "$rel/index.bin") $refs[$rel] = $ref;
        }
    } else {
        $rels = [''];
        $idx = $man['index'] ?? null;
        if (is_array($idx) && ($idx['url'] ?? null) === 'index.bin') $refs[''] = $idx;
    }
    $trees = []; $problem = null; $seen = [];
    foreach ($rels as $i => $rel) {
        $t = $rel === '' ? 0 : (preg_match('/^t(\d{1,6})$/D', $rel, $mm) ? (int)$mm[1] : $i);
        if (isset($seen[$t])) throw new InvalidArgumentException("timepoint $rel twice");
        $seen[$t] = true;
        $dir = $rel === '' ? $bricksRoot : "$bricksRoot/$rel";
        $tree = ['t' => $t, 'rel' => $rel, 'bricksDir' => $dir, 'X' => $X, 'Y' => $Y, 'Z' => $Z, 'C' => $C,
                 'nx' => $grids[0][0], 'ny' => $grids[0][1], 'nz' => $grids[0][2],
                 'TX' => intdiv($X + 511, 512), 'TY' => intdiv($Y + 511, 512),
                 'encoding' => 'v3', 'cols' => LUMEN_V3_COLS, 'index' => []];
        try {
            $tree['index'] = lumen_mig_v3_lod0_index($dir, $refs[$rel] ?? null, $grids, $C);
        } catch (InvalidArgumentException $e) {
            $problem = $problem ?? (($rel === '' ? 'bricks' : $rel) . ': ' . $e->getMessage());
        }
        $trees[] = $tree;
    }
    return [$trees, $problem];
}

/** Validate one v3 tree (index bytes + sha, grids, every referenced pack long enough); its LOD0 index. */
function lumen_mig_v3_lod0_index(string $dir, $ref, array $grids, int $C): array {
    if (!is_array($ref)) throw new InvalidArgumentException('no index entry in the manifest');
    $path = "$dir/index.bin";
    clearstatcache(true, $path);
    if (!is_file($path)) throw new InvalidArgumentException('index.bin missing');
    $size = (int)filesize($path);
    if ($size !== ($ref['bytes'] ?? null)) throw new InvalidArgumentException("index.bin size $size, manifest says " . json_encode($ref['bytes'] ?? null));
    $data = (string)file_get_contents($path);
    if (hash('sha256', $data) !== ($ref['sha256'] ?? null)) throw new InvalidArgumentException('index.bin sha256 differs from the manifest');
    $idx = lumen_v3_parse_index($data);
    if ($idx['channels'] !== $C || array_map(fn($l) => array_slice($l, 0, 3), $idx['levels']) !== $grids) throw new InvalidArgumentException('index.bin grids/channels differ from the manifest');
    $index = [];
    [$gx, $gy] = $grids[0];
    foreach ($idx['levels'] as $k => [$lx, $ly, $lz]) {
        $n = $lx * $ly * $lz;
        for ($c = 0; $c < $C; $c++) {
            $ends = [];
            $base = $idx['entriesAt'][$k] + $c * $n * LUMEN_V3_INDEX_ENTRY;
            $blk = substr($data, $base, $n * LUMEN_V3_INDEX_ENTRY);
            for ($i = 0; $i < $n; $i++) {
                $e = unpack('vp/Vo/Vl', $blk, $i * LUMEN_V3_INDEX_ENTRY);
                if (!$e['l']) continue;
                $end = $e['o'] + $e['l'];
                if (!isset($ends[$e['p']]) || $ends[$e['p']] < $end) $ends[$e['p']] = $end;
                if ($k === 0) {
                    $bx = $i % $gx; $r = intdiv($i, $gx); $by = $r % $gy; $bz = intdiv($r, $gy);
                    $index["$c:$bx:$by:$bz"] = [$dir . '/' . lumen_v3_pack_rel(0, $c, $e['p']), $e['o'], $e['l']];
                }
            }
            foreach ($ends as $pk => $end) {
                $pp = $dir . '/' . lumen_v3_pack_rel($k, $c, $pk);
                clearstatcache(true, $pp);
                if (!is_file($pp)) throw new InvalidArgumentException(lumen_v3_pack_rel($k, $c, $pk) . ' missing');
                $sz = (int)filesize($pp);
                if ($sz < $end) throw new InvalidArgumentException(lumen_v3_pack_rel($k, $c, $pk) . " holds $sz bytes, its bricks end at $end");
            }
        }
    }
    return $index;
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
        if (is_array($hit) && ($hit['sig'] ?? null) === $sig && is_array($hit['plan'] ?? null) && ($hit['plan']['dir'] ?? null) === $dir
            && array_key_exists('carry', $hit['plan'])) {
            $cache = [$dir => ['sig' => $sig, 'plan' => $hit['plan']]];
            return $hit['plan'];
        }
    }
    try {
        $raw = (string)file_get_contents($mpath);
        $sha = hash('sha256', $raw);
        [$man, $maps, $reduced] = lumen_mig_decode_manifest($raw);
        unset($raw);
        if (!is_array($man)) throw new InvalidArgumentException('manifest is not an object');
        if (($man['brickSize'] ?? LUMEN_MIG_BRICK) !== LUMEN_MIG_BRICK) throw new InvalidArgumentException('brickSize');
        $packing = $man['brickPacking'] ?? null;
        $trees = [];
        $tps = $man['timepoints'] ?? null;
        $isV3 = ($man['schema'] ?? null) === LUMEN_V3_SCHEMA;
        $v3Problem = null;
        $carry = $isV3 ? ['histograms' => null, 'dataset' => null, 'tph' => []] : lumen_mig_v2_carry($reduced);
        unset($reduced);
        $voxel = lumen_mig_manifest_voxel($man, $dir);
        if ($isV3) {
            [$trees, $v3Problem] = lumen_mig_build_v3_trees($type, "$dir/bricks", $man);
        } elseif ($type === 'live' && is_array($tps) && $tps && array_keys($tps) !== range(0, count($tps) - 1)) {
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
             'total' => $total, 'empty' => $total - count($unitBytes),
             'v3' => $isV3, 'v3Problem' => $v3Problem, 'voxel' => $voxel, 'carry' => $carry, 'sig' => $sig];
    // One plan cached per request: status walks every dataset, and keeping each one
    // (tens of MB for the largest) would add them all up against memory_limit.
    $cache = [$dir => ['sig' => $sig, 'plan' => $plan]];
    // A v3 plan also depends on index.bin and the packs (its validity): never cached on disk.
    if (!$isV3 && (is_dir(dirname($diskCache)) || @mkdir(dirname($diskCache), 0755, true))) {
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

/// ── Structure validity (repair detection) ────────────────────────────────────

const LUMEN_M002 = 'm002-planes';
const LUMEN_M003 = 'm003-layer-mips';
const LUMEN_M004 = 'm004-bricks-v3';
/** (incoming, live, old) directory names of the structure each migration swaps in. */
const LUMEN_MIG_SWAP_DIRS = [
    LUMEN_M002 => ['.planes-incoming', 'planes', '.planes-old'],
    LUMEN_M003 => ['.mips-incoming', 'mips', '.mips-old'],
    LUMEN_M004 => ['.bricks-incoming', 'bricks', 'bricks.v2-old'],
];

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

/** SPEC §12: the planes manifest's shape with layers/layerDepth after codec (key order is part of the contract). */
function lumen_mig_mips_manifest(array $tree, string $sha, string $producer, string $createdAt): array {
    return [
        'schema' => LUMEN_MIPS_SCHEMA,
        'formatVersion' => 3,
        'level' => 0,
        'dimensions' => ['x' => $tree['X'], 'y' => $tree['Y'], 'z' => $tree['Z']],
        'channels' => $tree['C'],
        'tileSize' => LUMEN_MIG_TILE,
        'tiles' => ['x' => $tree['TX'], 'y' => $tree['TY']],
        'codec' => 'png-gray8',
        'layers' => intdiv($tree['Z'] + 63, 64),
        'layerDepth' => LUMEN_MIPS_LAYER,
        'packPattern' => 'l{l}.bin',
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

function lumen_mig_tree_mips_valid(array $plan, array $tree, string $root = 'mips'): bool {
    $d = lumen_mig_tree_planes_dir($plan['dir'], $tree, $root);
    $doc = admin_read_json("$d/manifest.json");
    if ($doc === null) return false;
    $want = lumen_mig_mips_manifest($tree, $plan['sha'], '', '');
    foreach (['schema', 'formatVersion', 'level', 'dimensions', 'channels', 'tileSize', 'tiles', 'codec', 'layers', 'layerDepth', 'packPattern', 'headerBytes'] as $k) {
        if (($doc[$k] ?? null) !== $want[$k]) return false;
    }
    if ((is_array($doc['source'] ?? null) ? ($doc['source']['manifestSha256'] ?? null) : null) !== $plan['sha']) return false;
    $names = @scandir($d);
    if ($names === false) return false;
    $names = array_flip($names);
    for ($l = 0; $l < $want['layers']; $l++) if (!isset($names[sprintf('l%05d.bin', $l)])) return false;
    return true;
}

function lumen_mig_mips_valid(array $plan, string $root = 'mips'): bool {
    foreach ($plan['trees'] as $tree) if (!lumen_mig_tree_mips_valid($plan, $tree, $root)) return false;
    return true;
}

function lumen_mig_bricks_v3_valid(array $plan): bool {
    return !empty($plan['v3']) && $plan['v3Problem'] === null;
}

function lumen_mig_structure_valid(array $plan, string $mid): bool {
    if ($mid === LUMEN_M002) return lumen_mig_planes_valid($plan);
    if ($mid === LUMEN_M003) return lumen_mig_mips_valid($plan);
    if ($mid === LUMEN_M004) return lumen_mig_bricks_v3_valid($plan);
    return false;
}

/**
 * The version claims the migration's structure but it is missing or invalid. A v4
 * dataset whose v3 bricks are damaged is NOT repairable by m004 (its v2 source is gone):
 * that is a problem of the status row, never a pending repair.
 */
function lumen_mig_repair_needed(array $plan, int $fv, array $m): bool {
    if ($fv < $m['to']) return false;
    if ($m['id'] === LUMEN_M004) return empty($plan['v3']);
    return !lumen_mig_structure_valid($plan, $m['id']);
}

function lumen_mig_applicable(array $plan, int $fv, array $m): bool {
    return in_array($plan['type'], $m['types'], true) && ($fv === $m['from'] || lumen_mig_repair_needed($plan, $fv, $m));
}

// ── Capability probe (SPEC §5, §13.5) ────────────────────────────────────────

/**
 * The server executor's capability. Top-level available/reasons are m002's (the 1.58.0
 * contract); migrations[id] = {available, reasons}: m002 WebP decode + zlib, m003 zlib
 * (PNG in and out), m004 WebP decode + lossless WebP encode (GD ≥ PHP 8.1, probed by an
 * exact round trip of a 66³ brick holding every byte value). The host limits (memory,
 * max_execution_time) apply to every migration.
 */
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
        try { $png = lumen_mig_png_decode_gray(lumen_mig_png_encode($sample, 16, 48), 16, 48) === $sample; } catch (Throwable $e) { $png = false; }
    }
    if (!$png) $reasons[] = 'no_zlib';
    $host = [];
    $mem = lumen_up_ini_bytes((string)ini_get('memory_limit'));   // 0 = unlimited
    if ($mem > 0 && $mem < LUMEN_MIG_MIN_MEMORY) $host[] = 'low_memory';
    $met = (int)ini_get('max_execution_time');                    // 0 = unlimited
    if ($met > 0 && $met < LUMEN_MIG_MIN_EXEC_S) $host[] = 'exec_time_too_short';
    $lossless = $webp && lumen_mig_probe_v3_encode();
    $m004 = [];
    if (!$webp) $m004[] = 'no_webp_decode';
    if (!$lossless) $m004[] = 'no_webp_lossless_encode';
    if (!$png) $m004[] = 'no_zlib';
    $m002 = array_merge($reasons, $host);
    $m003 = array_merge($png ? [] : ['no_zlib'], $host);
    $m004 = array_merge($m004, $host);
    $caps = [
        'available' => !$m002, 'reasons' => $m002, 'webpDecode' => $webp, 'pngEncode' => $png,
        'webpLosslessEncode' => $lossless,
        'limits' => ['maxExecutionTime' => $met, 'memoryLimitBytes' => $mem ?: null,
                     'resettable' => lumen_mig_time_limit_resettable()],
        'backend' => 'php', 'vectorized' => false,
        'maxRunSeconds' => LUMEN_MIG_MAX_RUN_S, 'maxUnitBody' => LUMEN_MIG_MAX_BODY,
        'migrations' => [
            LUMEN_M002 => ['available' => !$m002, 'reasons' => $m002],
            LUMEN_M003 => ['available' => !$m003, 'reasons' => $m003],
            LUMEN_M004 => ['available' => !$m004, 'reasons' => $m004],
        ],
    ];
    if (!$webp) $caps['detail'] = function_exists('gd_info') ? 'GD cannot decode lossless WebP exactly' : 'the gd extension is not loaded';
    elseif (!$lossless) $caps['detail'] = (PHP_VERSION_ID < 80100 || !defined('IMG_WEBP_LOSSLESS')) ? 'lossless WebP encoding needs PHP 8.1 or later' : 'GD does not encode lossless WebP exactly';
    return $caps;
}

/** m004's server probe: a 66³ brick holding every byte value, encoded, sniffed as a 594×528 VP8L, decoded back exactly. */
function lumen_mig_probe_v3_encode(): bool {
    if (!lumen_v3_webp_lossless_ok()) return false;
    try {
        $b = '';
        for ($i = 0, $n = LUMEN_V3_SLICE ** 3; $i < $n; $i++) $b .= chr((($i * 2654435761) & 0xFFFFFFFF) >> 13 & 0xFF);
        $b = str_repeat("\0", 8 * LUMEN_V3_SLICE * LUMEN_V3_SLICE) . substr($b, 8 * LUMEN_V3_SLICE * LUMEN_V3_SLICE);
        $data = lumen_v3_encode_brick($b);
        if (lumen_v3_webp_lossless_size($data) !== [LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H]) return false;
        return lumen_v3_decode_brick($data) === $b;
    } catch (Throwable $e) {
        return false;
    }
}

/** 409 server_unavailable unless the server executor can run migration $mid here. */
function lumen_mig_require_server($mid): void {
    $mc = lumen_mig_capabilities()['migrations'][is_string($mid) && $mid !== '' ? $mid : LUMEN_M002] ?? null;
    if ($mc === null) throw new LumenMigError('unknown_migration');
    if (!$mc['available']) throw new LumenMigError('server_unavailable', 409, implode(',', $mc['reasons']));
}

/**
 * max_execution_time in seconds (0 = unlimited). A test defines LUMEN_MIG_EXEC_LIMIT to
 * drive the time-limited paths (step splitting, deadlines) without a real limit.
 */
function lumen_mig_exec_limit(): int {
    return defined('LUMEN_MIG_EXEC_LIMIT') ? (int)LUMEN_MIG_EXEC_LIMIT : (int)ini_get('max_execution_time');
}

/** A request's time budget in seconds: ≤ 20, and 5 s under max_execution_time. */
function lumen_mig_budget($asked): float {
    $s = is_numeric($asked) ? (float)$asked : (float)LUMEN_MIG_MAX_RUN_S;
    // The floor is a constant so a test can drive the time-bounded paths with a 0 s budget.
    $floor = defined('LUMEN_MIG_BUDGET_FLOOR') ? (float)LUMEN_MIG_BUDGET_FLOOR : 1.0;
    $s = max($floor, min((float)LUMEN_MIG_MAX_RUN_S, $s));
    $met = lumen_mig_exec_limit();
    if ($met > 0) $s = max($floor, min($s, (float)($met - 5)));
    return $s;
}

/** Seconds kept free under max_execution_time when deciding whether a step fits. */
const LUMEN_MIG_TIME_MARGIN = 3.0;
/** Server steps of one unit that may die with their request before it is reported (unit_timeout). */
const LUMEN_MIG_MAX_ATTEMPTS = 2;

/**
 * The request's execution clock. PHP kills a request at max_execution_time and a unit
 * (or an octant) is indivisible: a step may start only if it fits in what is left.
 * set_time_limit() restarts the count where the host allows it (many shared hosts do;
 * a disabled function or a refusal leaves the deadline at the request's start + limit).
 */
function lumen_mig_exec_clock(): array {
    $met = lumen_mig_exec_limit();
    $test = defined('LUMEN_MIG_EXEC_LIMIT');
    $start = $test ? microtime(true) : (float)($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
    return ['limited' => $met > 0, 'met' => $met, 'start' => $start, 'reset' => false,
            'deadline' => $met > 0 ? $start + $met : INF, 'test' => $test];
}

/** Restart the count before a step (where allowed); the seconds the step may then take. */
function lumen_mig_clock_step(array &$clock): float {
    if (!$clock['limited']) return INF;
    $now = microtime(true);
    if (!$clock['test'] && function_exists('set_time_limit') && @set_time_limit($clock['met'])) {
        $clock['reset'] = true;
        $clock['deadline'] = $now + $clock['met'];
    }
    return $clock['deadline'] - $now - LUMEN_MIG_TIME_MARGIN;
}

/** Whether set_time_limit() restarts the execution clock on this host (status: limits.resettable). */
function lumen_mig_time_limit_resettable(): bool {
    $met = (int)ini_get('max_execution_time');
    if ($met <= 0) return true;
    return function_exists('set_time_limit') && @set_time_limit($met);
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
    if ($enc === 'v3') {
        try {
            return [lumen_v3_decode_brick($bytes), 'v3'];
        } catch (InvalidArgumentException $e) {
            throw new RuntimeException($e->getMessage());
        }
    }
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
    if ($dec[1] === 'v3') return substr($dec[0], (($zz + 1) * LUMEN_V3_SLICE + $yy + 1) * LUMEN_V3_SLICE + 1, LUMEN_MIG_BRICK);
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

/// ── Unit sets of each migration ──────────────────────────────────────────────

/** Key string of a unit: m002 t.z.c.y.x (§4), m003 t.l.c.y.x (§12), m004 t.k.c.z.y.x (§13.5). */
function lumen_mig_unit_key_for(string $mid, array $u): string {
    if ($mid === LUMEN_M003) return vsprintf('t%d.l%d.c%d.y%d.x%d', $u);
    if ($mid === LUMEN_M004) return vsprintf('t%d.k%d.c%d.z%d.y%d.x%d', $u);
    return lumen_mig_unit_key(...$u);
}

function lumen_mig_parse_key_for(string $mid, $key): array {
    $rx = [LUMEN_M003 => '/^t(\d{1,6})\.l(\d{1,5})\.c(\d{1,3})\.y(\d{1,4})\.x(\d{1,4})$/D',
           LUMEN_M004 => '/^t(\d{1,6})\.k(\d{1,2})\.c(\d{1,3})\.z(\d{1,5})\.y(\d{1,5})\.x(\d{1,5})$/D'][$mid] ?? null;
    if ($rx === null) return lumen_mig_parse_key($key);
    if (!is_string($key) || !preg_match($rx, $key, $m)) throw new LumenMigError('bad_unit');
    return array_map('intval', array_slice($m, 1));
}

/**
 * The work of one migration on one dataset (twin of dataset_migrations.UnitSet):
 * ['mid', 'units' => [key => tuple] in the order executors take them, 'unitBytes' =>
 * [key => input bytes], 'total', 'empty' (done at plan time), 'inputs' => [t => sha256
 * of the planes manifest] (m003), 'refs' => [key => [[z, offset, length]…]] (m003),
 * 'levels' => the v3 ladder (m004)].
 */
function lumen_mig_unitset(array $plan, string $mid): array {
    static $cache = [];
    if ($mid === LUMEN_M002) {
        return ['mid' => LUMEN_M002, 'units' => $plan['units'], 'unitBytes' => $plan['unitBytes'],
                'total' => $plan['total'], 'empty' => $plan['empty'], 'inputs' => [], 'refs' => null, 'levels' => null];
    }
    if ($mid !== LUMEN_M003 && $mid !== LUMEN_M004) throw new LumenMigError('unknown_migration');
    $stamp = '';
    if ($mid === LUMEN_M003) {
        $ts = array_keys($plan['trees']);
        sort($ts);
        foreach ($ts as $t) {
            $p = lumen_mig_tree_planes_dir($plan['dir'], $plan['trees'][$t]) . '/manifest.json';
            clearstatcache(true, $p);
            $stamp .= is_file($p) ? filemtime($p) . ':' . filesize($p) . ';' : 'none;';
        }
    }
    $ck = $plan['dir'] . '|' . $plan['sig'] . '|' . $mid . '|' . $stamp;
    if (isset($cache[$ck])) return $cache[$ck];
    if ($mid === LUMEN_M003) {
        // Across requests too: m003's plan reads one pack header per plane of every tree.
        $disk = lumen_mig_root() . '/.plans/' . $plan['type'] . '__' . $plan['folder'] . '__' . LUMEN_M003 . '.ser';
        $hit = is_file($disk) ? @unserialize((string)@file_get_contents($disk), ['allowed_classes' => false]) : null;
        if (is_array($hit) && ($hit['key'] ?? null) === $ck && is_array($hit['us'] ?? null)) {
            $us = $hit['us'];
        } else {
            $us = lumen_mig_m003_unitset($plan);
            if (is_dir(dirname($disk)) || @mkdir(dirname($disk), 0755, true)) @lumen_write_file_atomic($disk, serialize(['key' => $ck, 'us' => $us]));
        }
    } else {
        $us = lumen_mig_m004_unitset($plan);
    }
    $cache = [$ck => $us];      // one dataset's unit set per request (memory)
    return $us;
}

/** m003 units from the plane pack headers: a unit is empty when all its ≤ 64 tiles have length 0. */
function lumen_mig_m003_unitset(array $plan): array {
    if (!lumen_mig_planes_valid($plan)) throw new LumenMigError('planes_missing', 409);
    $refs = []; $total = 0; $inputs = [];
    $ts = array_keys($plan['trees']);
    sort($ts);
    foreach ($ts as $t) {
        $tree = $plan['trees'][$t];
        $d = lumen_mig_tree_planes_dir($plan['dir'], $tree);
        $inputs[(string)$t] = hash_file('sha256', "$d/manifest.json");
        $perC = $tree['TY'] * $tree['TX'];
        $total += intdiv($tree['Z'] + 63, 64) * $tree['C'] * $perC;
        for ($z = 0; $z < $tree['Z']; $z++) {
            $name = sprintf('z%05d.bin', $z);
            $fh = @fopen("$d/$name", 'rb');
            if ($fh === false) throw new LumenMigError('planes_invalid', 409, "$name: missing");
            try {
                $entries = lumen_mig_pack_entries($fh, LUMEN_MIG_PACK_MAGIC, $tree['C'], $tree['TX'], $tree['TY'], $z);
            } catch (InvalidArgumentException $e) {
                throw new LumenMigError('planes_invalid', 409, "$name: " . $e->getMessage());
            } finally {
                fclose($fh);
            }
            $l = intdiv($z, 64);
            foreach ($entries as $i => [$off, $len]) {
                if (!$len) continue;
                $c = intdiv($i, $perC); $rem = $i % $perC;
                $refs[vsprintf('t%d.l%d.c%d.y%d.x%d', [$t, $l, $c, intdiv($rem, $tree['TX']), $rem % $tree['TX']])][] = [$z, $off, $len];
            }
        }
    }
    $units = [];
    foreach (array_keys($refs) as $k) $units[$k] = lumen_mig_parse_key_for(LUMEN_M003, $k);
    uasort($units, fn($a, $b) => $a <=> $b);
    $bytes = [];
    foreach ($units as $k => $_u) $bytes[$k] = array_sum(array_column($refs[$k], 2));
    $sortedRefs = [];
    foreach ($units as $k => $_u) $sortedRefs[$k] = $refs[$k];
    return ['mid' => LUMEN_M003, 'units' => $units, 'unitBytes' => $bytes, 'total' => $total,
            'empty' => $total - count($units), 'inputs' => $inputs, 'refs' => $sortedRefs, 'levels' => null];
}

/** m003 before planes/ exists: every unit counted (an upper bound), bytes estimated from the bricks. */
function lumen_mig_m003_estimate(array $plan): array {
    $total = 0;
    foreach ($plan['trees'] as $tree) $total += intdiv($tree['Z'] + 63, 64) * $tree['C'] * $tree['TY'] * $tree['TX'];
    $est = (int)(array_sum($plan['unitBytes']) * LUMEN_MIG_PLANES_RATIO);
    return ['units' => $total, 'bytes' => $est, 'unitsTotal' => $total, 'bytesTotal' => $est, 'exact' => false];
}

/** The v3 ladder shared by every tree (a timelapse's frames must agree), each level with its grid. */
function lumen_mig_m004_levels(array $plan): array {
    $ts = array_keys($plan['trees']);
    sort($ts);
    $first = $plan['trees'][$ts[0]];
    foreach ($ts as $t) {
        $tr = $plan['trees'][$t];
        if ([$tr['X'], $tr['Y'], $tr['Z'], $tr['C']] !== [$first['X'], $first['Y'], $first['Z'], $first['C']]) {
            throw new LumenMigError('trees_differ', 409, sprintf('timepoint %s: (%d, %d, %d) x %d channels, %s: (%d, %d, %d) x %d',
                $first['rel'], $first['X'], $first['Y'], $first['Z'], $first['C'], $tr['rel'], $tr['X'], $tr['Y'], $tr['Z'], $tr['C']));
        }
    }
    $levels = lumen_v3_ladder($first['X'], $first['Y'], $first['Z'], $plan['voxel']);
    foreach ($levels as &$L) $L['grid'] = lumen_v3_grid($L['dimensions']);
    unset($L);
    return $levels;
}

/**
 * m004 units (SPEC §13.5): 4×4×4 super-blocks of every level, channel and tree, ordered
 * by level. A level-k unit is empty iff no v2 LOD0 brick of its channel lies in its
 * footprint (level-k brick b covers LOD0 bricks b·2^k in XY and b·2^hz in Z, hz = the
 * Z halvings up to k). Bytes = the footprint's v2 bytes / (4^k · 2^hz) (an estimate).
 */
function lumen_mig_m004_unitset(array $plan): array {
    if (!empty($plan['v3'])) throw new LumenMigError('already_v3', 409);
    $levels = lumen_mig_m004_levels($plan);
    $zs = [0];
    for ($k = 1; $k < count($levels); $k++) $zs[] = $zs[$k - 1] + ($levels[$k]['halveZ'] ? 1 : 0);
    $bytes = []; $total = 0;
    $ts = array_keys($plan['trees']);
    sort($ts);
    foreach ($ts as $t) {
        $tree = $plan['trees'][$t];
        for ($c = 0; $c < $tree['C']; $c++) foreach ($levels as $L) {
            [$gx, $gy, $gz] = $L['grid'];
            $total += intdiv($gx + 3, 4) * intdiv($gy + 3, 4) * intdiv($gz + 3, 4);
        }
        foreach ($tree['index'] as $key => $ref) {
            [$c, $bx, $by, $bz] = array_map('intval', explode(':', $key));
            foreach ($zs as $k => $zk) {
                $u = [$t, $k, $c, ($bz >> $zk) >> 2, ($by >> $k) >> 2, ($bx >> $k) >> 2];
                $uk = implode(',', $u);
                $bytes[$uk] = ($bytes[$uk] ?? 0) + $ref[2];
            }
        }
    }
    $units = [];
    foreach ($bytes as $uk => $b) {
        $u = array_map('intval', explode(',', $uk));
        $units[] = [$u, max(1, $b >> (2 * $u[1] + $zs[$u[1]]))];
    }
    unset($bytes);
    usort($units, fn($a, $b) => [$a[0][1], $a[0][0], $a[0][2], $a[0][3], $a[0][4], $a[0][5]] <=> [$b[0][1], $b[0][0], $b[0][2], $b[0][3], $b[0][4], $b[0][5]]);
    $out = []; $ub = [];
    foreach ($units as [$u, $b]) {
        $k = lumen_mig_unit_key_for(LUMEN_M004, $u);
        $out[$k] = $u;
        $ub[$k] = $b;
    }
    return ['mid' => LUMEN_M004, 'units' => $out, 'unitBytes' => $ub, 'total' => $total,
            'empty' => $total - count($out), 'inputs' => [], 'refs' => null, 'levels' => $levels];
}

/**
 * [runnable keys, pending keys] not yet done. m004: a level-k unit of tree t / channel c
 * is runnable only once every unit of the lower levels of (t, c) is done.
 */
function lumen_mig_pending_units(array $us, array $done): array {
    $pending = [];
    foreach ($us['units'] as $k => $u) if (!isset($done[$k])) $pending[$k] = $u;
    if ($us['mid'] !== LUMEN_M004) return [$pending, $pending];
    $front = [];
    foreach ($pending as $u) {
        $g = $u[0] . ':' . $u[2];
        if (!isset($front[$g]) || $u[1] < $front[$g]) $front[$g] = $u[1];
    }
    $run = [];
    foreach ($pending as $k => $u) if ($u[1] === $front[$u[0] . ':' . $u[2]]) $run[$k] = $u;
    return [$run, $pending];
}

function lumen_mig_m004_level_ready(array $us, array $done, array $unit): bool {
    foreach ($us['units'] as $k => $u) {
        if ($u[0] === $unit[0] && $u[2] === $unit[2] && $u[1] < $unit[1] && !isset($done[$k])) return false;
    }
    return true;
}

function lumen_mig_m004_check_unit(array $us, array $plan, array $unit): void {
    [$t, $k, $c, $BZ, $BY, $BX] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $k >= count($us['levels']) || $c >= $tree['C']) throw new LumenMigError('bad_unit');
    [$gx, $gy, $gz] = $us['levels'][$k]['grid'];
    if ($BZ >= intdiv($gz + 3, 4) || $BY >= intdiv($gy + 3, 4) || $BX >= intdiv($gx + 3, 4)) throw new LumenMigError('bad_unit');
}

/** [tree, w, h] of an m003 unit; bad_unit outside the trees. */
function lumen_mig_m003_unit_geometry(array $plan, array $unit): array {
    [$t, $l, $c, $ty, $tx] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $l >= intdiv($tree['Z'] + 63, 64) || $c >= $tree['C'] || $ty >= $tree['TY'] || $tx >= $tree['TX']) throw new LumenMigError('bad_unit');
    return [$tree, min(LUMEN_MIG_TILE, $tree['X'] - $tx * LUMEN_MIG_TILE), min(LUMEN_MIG_TILE, $tree['Y'] - $ty * LUMEN_MIG_TILE)];
}

/** (bz, by, bx) of the bricks of an m004 unit (its super-block, or its octant $part, ∩ the level's grid), brick order. */
function lumen_mig_m004_unit_bricks(array $us, array $unit, int $part = -1): array {
    [, $k, , $BZ, $BY, $BX] = $unit;
    [$gx, $gy, $gz] = $us['levels'][$k]['grid'];
    [$b0, $b1] = lumen_v3_part_bricks([$BX, $BY, $BZ], $part);
    $out = [];
    for ($bz = $b0[2]; $bz < min($gz, $b1[2]); $bz++)
        for ($by = $b0[1]; $by < min($gy, $b1[1]); $by++)
            for ($bx = $b0[0]; $bx < min($gx, $b1[0]); $bx++) $out[] = [$bz, $by, $bx];
    return $out;
}

/** Level-k voxel range [lo, hi) per axis (x, y, z) a unit's 66³ bricks read. */
function lumen_mig_m004_unit_ranges(array $us, array $unit): array {
    [, $k, , $BZ, $BY, $BX] = $unit;
    $d = $us['levels'][$k]['dimensions'];
    $out = [];
    foreach ([[$BX, $d['x']], [$BY, $d['y']], [$BZ, $d['z']]] as [$B, $n]) {
        $a = 256 * $B;
        $out[] = [max(0, $a - 1), min($n, $a + 257)];
    }
    return $out;
}

/** The previous level's voxel range the reduction of a level-k ≥ 1 unit reads. */
function lumen_mig_m004_source_ranges(array $us, array $unit): array {
    $k = $unit[1];
    $P = $us['levels'][$k - 1]['dimensions'];
    $out = [];
    foreach (lumen_mig_m004_unit_ranges($us, $unit) as $axis => [$lo, $hi]) {
        $n = [$P['x'], $P['y'], $P['z']][$axis];
        $out[] = ($axis === 2 && !$us['levels'][$k]['halveZ']) ? [$lo, $hi] : [2 * $lo, min($n, 2 * $hi)];
    }
    return $out;
}

/** (bz, by, bx) of the bricks of a grid whose interior meets a voxel range. */
function lumen_mig_bricks_overlapping(array $rng, array $grid): array {
    [[$x0, $x1], [$y0, $y1], [$z0, $z1]] = $rng;
    [$gx, $gy, $gz] = $grid;
    $out = [];
    for ($bz = intdiv($z0, 64); $bz < min($gz, intdiv($z1 + 63, 64)); $bz++)
        for ($by = intdiv($y0, 64); $by < min($gy, intdiv($y1 + 63, 64)); $by++)
            for ($bx = intdiv($x0, 64); $bx < min($gx, intdiv($x1 + 63, 64)); $bx++) $out[] = [$bz, $by, $bx];
    return $out;
}

function lumen_mig_mip_tile_path(string $store, array $u): string {
    return sprintf('%s/t%d/l%d/c%d.y%d.x%d.png', $store, $u[0], $u[1], $u[2], $u[3], $u[4]);
}

function lumen_mig_v3_store_brick(string $store, int $t, int $k, int $c, int $bz, int $by, int $bx): string {
    return "$store/t$t/k$k/c$c/z$bz.y$by.x$bx.webp";
}

// ── Server executor: m003 and m004 units ─────────────────────────────────────

/** One m003 unit: the ≤ 64 plane tiles of (c, ty, tx) in layer l, decoded, max'ed. [png|null, bytesRead]. */
function lumen_mig_process_unit_m003(array $plan, array $us, array $unit, string $key): array {
    [$tree, $w, $h] = lumen_mig_m003_unit_geometry($plan, $unit);
    [, , $c, $ty, $tx] = $unit;
    $d = lumen_mig_tree_planes_dir($plan['dir'], $tree);
    $tiles = []; $read = 0;
    foreach ($us['refs'][$key] ?? [] as [$z, $off, $len]) {
        $name = sprintf('z%05d.bin', $z);
        $fh = @fopen("$d/$name", 'rb');
        if ($fh === false) throw new LumenMigError('plane_unreadable', 500, $name);
        $png = '';
        try {
            if (@fseek($fh, $off) === 0) {
                while (strlen($png) < $len) {
                    $chunk = fread($fh, $len - strlen($png));
                    if ($chunk === false || $chunk === '') break;
                    $png .= $chunk;
                }
            }
        } finally {
            fclose($fh);
        }
        if (strlen($png) !== $len) throw new LumenMigError('plane_unreadable', 500, "$name@$off: short read");
        $read += $len;
        try {
            $tiles[] = lumen_mig_png_decode_gray($png, $w, $h);
        } catch (InvalidArgumentException $e) {
            throw new LumenMigError('plane_undecodable', 500, "$name c$c y$ty x$tx: " . $e->getMessage());
        }
    }
    if (!$tiles) return [null, $read];
    // The maximum in bands of 64 rows: ≤ 64 decoded tiles (16 MiB) + the band's working set.
    $band = 64 * $w; $out = [];
    for ($o = 0, $n = $w * $h; $o < $n; $o += $band) $out[] = lumen_mig_bytes_max(array_map(fn($t) => substr($t, $o, $band), $tiles));
    unset($tiles);
    $mip = implode('', $out);
    if (strspn($mip, "\0") === strlen($mip)) return [null, $read];
    return [lumen_mig_png_encode($mip, $w, $h), $read];
}

/**
 * One m004 unit (SPEC §13.5): the level-k voxels of the unit's range — level 0 the v2
 * LOD0 bricks (absent = zeros), level k ≥ 1 the 2×2(×2) mean of the level k−1 bricks of
 * the tile store — cut into 66³ bricks, ESS, lossless WebP. Source bricks are decoded
 * lazily and kept for one source brick layer at a time (the builder walks z upward), so
 * memory stays near the unit's region (≤ 17 MB) + one layer of decoded bricks.
 * $part ∈ [0, 8): only that octant's bricks (lumen_v3_build_unit).
 * @return array [ ["bz.by.bx" => webp] in brick order, bytesRead ]
 */
function lumen_mig_process_unit_m004(array $plan, array $us, array $unit, string $store, int $part = -1): array {
    [$t, $k, $c] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $k >= count($us['levels']) || $c >= $tree['C']) throw new LumenMigError('bad_unit');
    $read = 0;
    $layer = -1; $bricks = [];
    $handles = [];
    $load = function (int $bx, int $by, int $bz) use ($k, $c, $t, $tree, $store, &$read, &$handles) {
        if ($k === 0) {
            $ref = $tree['index']["$c:$bx:$by:$bz"] ?? null;
            if ($ref === null) return null;
            [$path, $off, $len] = $ref;
            if (!isset($handles[$path])) {
                $fh = @fopen($path, 'rb');
                if ($fh === false) throw new LumenMigError('brick_unreadable', 500, basename($path) . ': missing');
                $handles[$path] = $fh;
            }
            $fh = $handles[$path];
            $raw = '';
            if (@fseek($fh, $off) === 0) {
                while (strlen($raw) < $len) {
                    $chunk = fread($fh, $len - strlen($raw));
                    if ($chunk === false || $chunk === '') break;
                    $raw .= $chunk;
                }
            }
            if (strlen($raw) !== $len) throw new LumenMigError('brick_unreadable', 500, basename($path) . "@$off: short read");
            $read += $len;
            try {
                return lumen_mig_decode_brick($raw, $tree, LUMEN_MIG_BRICK);
            } catch (RuntimeException $e) {
                throw new LumenMigError('brick_undecodable', 500, "c$c x$bx y$by z$bz: " . $e->getMessage());
            }
        }
        $p = lumen_mig_v3_store_brick($store, $t, $k - 1, $c, $bz, $by, $bx);
        $raw = @file_get_contents($p);
        if (!is_string($raw)) return null;
        $read += strlen($raw);
        try {
            return [lumen_v3_decode_brick($raw), 'v3'];
        } catch (Throwable $e) {
            throw new LumenMigError('brick_undecodable', 500, sprintf('level %d c%d (%d, %d, %d): %s', $k - 1, $c, $bz, $by, $bx, $e->getMessage()));
        }
    };
    $cols = $tree['cols'];
    $zero64 = str_repeat("\0", 64);
    $plane = function (int $z, int $x0, int $x1, int $y0, int $y1) use (&$layer, &$bricks, $load, $cols, $zero64): string {
        $bz = $z >> 6; $zz = $z & 63;
        if ($bz !== $layer) { $bricks = []; $layer = $bz; }
        $bx0 = $x0 >> 6; $bx1 = ($x1 - 1) >> 6;
        $skip = $x0 - 64 * $bx0; $w = $x1 - $x0;
        $rows = [];
        $decs = null; $curBy = -1;
        for ($y = $y0; $y < $y1; $y++) {
            $by = $y >> 6;
            if ($by !== $curBy) {
                $decs = [];
                for ($bx = $bx0; $bx <= $bx1; $bx++) {
                    $key = "$bx.$by";
                    if (!array_key_exists($key, $bricks)) $bricks[$key] = $load($bx, $by, $bz);
                    $decs[] = $bricks[$key];
                }
                $curBy = $by;
            }
            $row = '';
            foreach ($decs as $dec) $row .= $dec === null ? $zero64 : lumen_mig_brick_row($dec, $cols, $zz, $y & 63);
            $rows[] = substr($row, $skip, $w);
        }
        return implode('', $rows);
    };
    try {
        [$out] = lumen_v3_build_unit($us['levels'], $k, $unit[3], $unit[4], $unit[5], $plane, null, $part);
    } finally {
        foreach ($handles as $fh) fclose($fh);
        $bricks = [];
    }
    return [$out, $read];
}

/** One unit by the server executor: [result, bytesRead, bytesWritten]. */
function lumen_mig_process_any(array $plan, array $us, array $unit, string $key, string $store): array {
    if ($us['mid'] === LUMEN_M002) {
        [$tiles, $r] = lumen_mig_process_unit($plan, $unit);
        return [$tiles, $r, array_sum(array_map('strlen', $tiles))];
    }
    if ($us['mid'] === LUMEN_M003) {
        [$png, $r] = lumen_mig_process_unit_m003($plan, $us, $unit, $key);
        return [$png, $r, $png === null ? 0 : strlen($png)];
    }
    [$bricks, $r] = lumen_mig_process_unit_m004($plan, $us, $unit, $store);
    return [$bricks, $r, array_sum(array_map('strlen', $bricks))];
}

// ── Journal and tile store ───────────────────────────────────────────────────

function lumen_mig_save_journal(string $path, array $j): void {
    $j['updatedAt'] = lumen_mig_now();
    $j['done'] = array_values($j['done'] ?? []);
    // Maps keyed "0", "1"… would become JSON LISTS (PHP turns numeric string keys into
    // integers), which the Python twin cannot read as {t: sha}.
    foreach (['partial', 'attempts', 'timing'] as $k) if (array_key_exists($k, $j) && !$j[$k]) unset($j[$k]);
    if (isset($j['timing']) && is_array($j['timing'])) $j['timing'] = array_map(fn($v) => (object)$v, $j['timing']);
    foreach (['sourceManifests', 'inputManifests', 'executors', 'units', 'assembly', 'partial', 'attempts', 'timing'] as $k) if (isset($j[$k]) && is_array($j[$k])) $j[$k] = (object)$j[$k];
    $json = json_encode($j, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false || !lumen_write_file_atomic($path, $json)) throw new LumenMigError('journal_write_failed', 500);
}

/** API summary of a journal (twin of dataset_migrations._summary): `done` counts the empty units. */
function lumen_mig_summary(array $j, ?array $us = null): array {
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
    if ($us !== null) {
        $done = array_flip($j['done'] ?? []);
        $rest = 0;
        foreach ($us['unitBytes'] as $k => $b) if (!isset($done[$k])) $rest += $b;
        $out['bytesRemaining'] = $rest;
    }
    return $out;
}

/** Fail the job when the bricks manifest (or, for m003, a planes manifest) changed since it was planned. */
function lumen_mig_check_source(array $plan, array &$j, string $path, bool $persist = true): void {
    clearstatcache(true, $plan['manifestPath']);
    $current = @hash_file('sha256', $plan['manifestPath']);
    $changed = false;
    foreach ((array)($j['sourceManifests'] ?? []) as $sha) if ($sha !== $current) { $changed = true; break; }
    if (!$changed) {
        foreach ((array)($j['inputManifests'] ?? []) as $t => $sha) {
            $tree = $plan['trees'][(int)$t] ?? null;
            $p = $tree !== null ? lumen_mig_tree_planes_dir($plan['dir'], $tree) . '/manifest.json' : null;
            $cur = ($p !== null && is_file($p)) ? hash_file('sha256', $p) : null;
            if ($cur !== $sha) { $changed = true; break; }
        }
    }
    if ($changed) {
        if ($persist && ($j['state'] ?? null) !== 'failed') {
            $j['state'] = 'failed';
            $j['error'] = 'source_changed';
            lumen_mig_save_journal($path, $j);
        }
        throw new LumenMigError('source_changed', 409);
    }
}

function lumen_mig_open_job($datasetId, $mid): array {
    $m = lumen_mig_migration($mid);
    $plan = lumen_mig_plan_for($datasetId);
    return [$m, $plan, lumen_mig_journal_path($plan['type'], $plan['folder'], $m['id'])];
}

/** Refuse a new job the disk cannot hold: twin of dataset_migrations._check_disk. */
function lumen_mig_check_disk(array $plan, string $mid = LUMEN_M002, ?array $us = null): void {
    if ($mid === LUMEN_M003 && $us !== null) $est = (int)(array_sum($us['unitBytes']) * 0.05);
    elseif ($mid === LUMEN_M004) $est = (int)(array_sum($plan['unitBytes']) * 8 / 7 * 1.3);
    else $est = (int)(array_sum($plan['unitBytes']) * LUMEN_MIG_PLANES_RATIO);
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

function lumen_mig_swapped_only_summary(array $j): array {
    return array_merge(lumen_mig_summary($j), ['pending' => 0, 'runnable' => 0, 'offset' => 0, 'units' => []]);
}

/** Per-level progress of an m004 job. */
function lumen_mig_levels_progress(array $us, array $done): array {
    $rows = [];
    foreach ($us['levels'] ?? [] as $L) {
        $n = 0; $d = 0;
        foreach ($us['units'] as $k => $u) if ($u[1] === $L['level']) { $n++; if (isset($done[$k])) $d++; }
        $rows[] = ['level' => $L['level'], 'dimensions' => $L['dimensions'], 'voxelSize' => $L['voxelSize'],
                   'gridSize' => ['x' => $L['grid'][0], 'y' => $L['grid'][1], 'z' => $L['grid'][2]],
                   'halveZ' => $L['halveZ'], 'units' => $n, 'done' => $d];
    }
    return $rows;
}

/**
 * Create (or resume) a job; its summary and a page of the unit keys an executor may take
 * NOW (`units`; for m004 the pending units of the lowest unfinished level of each
 * tree/channel — `runnable` of `pending`).
 */
function lumen_mig_plan($datasetId, $mid, $offset = 0, $limit = 10000): array {
    $m = lumen_mig_migration($mid);
    try {
        [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    } catch (LumenMigError $e) {
        // m004 interrupted between its two renames: bricks/ is momentarily absent.
        if ($m['id'] === LUMEN_M004 && in_array($e->codeName, ['no_manifest', 'manifest_invalid'], true)) {
            [$type, $folder, $ds] = lumen_mig_resolve($datasetId);
            $j = lumen_mig_load_journal(lumen_mig_journal_path($type, $folder, $m['id']));
            if ($j !== null && (($j['state'] ?? null) === 'swapped' || is_dir("$ds/.bricks-incoming"))) return lumen_mig_swapped_only_summary($j);
        }
        throw $e;
    }
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
        if ($j !== null && ($j['state'] ?? null) !== 'swapped') {
            try {
                lumen_mig_check_source($plan, $j, $path, false);
            } catch (LumenMigError $e) {
                lumen_mig_rrmdir($store);
                $j = null;
            }
        }
        if ($j !== null && !empty($j['attempts'])) {
            // A (re)started job gives the server executor's units a fresh count: the
            // operator may have raised max_execution_time since a unit_timeout.
            unset($j['attempts']);
            lumen_mig_save_journal($path, $j);
        }
        if ($j === null) {
            $fv = lumen_mig_format_version(lumen_mig_read_metadata($plan['dir']));
            if (!lumen_mig_applicable($plan, $fv, $m)) throw new LumenMigError('not_applicable', 409);
            $incoming = LUMEN_MIG_SWAP_DIRS[$m['id']][0];
            if ($m['id'] === LUMEN_M004 && !empty($plan['v3'])) {
                // A v3 tree already in place at version 3 (a swap whose journal was lost):
                // only the re-stamp and the bump remain.
                if (!lumen_mig_bricks_v3_valid($plan)) throw new LumenMigError('bricks_v3_invalid', 409, $plan['v3Problem']);
                $j = ['migration' => $m['id'], 'dataset' => $plan['dataset'], 'createdAt' => lumen_mig_now(),
                      'sourceManifests' => [], 'units' => ['total' => 0, 'empty' => 0], 'done' => [],
                      'executors' => ['browser' => 0, 'server' => 0], 'state' => 'swapped', 'newManifestSha' => $plan['sha']];
                lumen_mig_save_journal($path, $j);
                return $j;
            }
            $us = lumen_mig_unitset($plan, $m['id']);
            lumen_mig_rrmdir($plan['dir'] . '/' . $incoming);
            lumen_mig_check_disk($plan, $m['id'], $us);
            $ts = array_keys($plan['trees']);
            sort($ts);
            $src = [];
            foreach ($ts as $t) $src[(string)$t] = $plan['sha'];
            $j = ['migration' => $m['id'], 'dataset' => $plan['dataset'], 'createdAt' => lumen_mig_now(),
                  'sourceManifests' => $src, 'units' => ['total' => $us['total'], 'empty' => $us['empty']],
                  'done' => [], 'executors' => ['browser' => 0, 'server' => 0], 'state' => 'running'];
            if ($us['inputs']) $j['inputManifests'] = $us['inputs'];
            lumen_mig_save_journal($path, $j);
        }
        return $j;
    });
    if (($j['state'] ?? null) === 'swapped') return array_merge(['ok' => true], lumen_mig_swapped_only_summary($j));
    $us = lumen_mig_unitset($plan, $m['id']);
    $done = array_flip($j['done'] ?? []);
    [$runnable, $pending] = lumen_mig_pending_units($us, $done);
    $offset = max(0, (int)$offset);
    $limit = max(1, min(100000, (int)($limit ?: 10000)));
    $out = array_merge(['ok' => true], lumen_mig_summary($j, $us),
                       ['pending' => count($pending), 'runnable' => count($runnable), 'offset' => $offset,
                        'units' => array_slice(array_keys($runnable), $offset, $limit)]);
    if ($m['id'] === LUMEN_M004) $out['levels'] = lumen_mig_levels_progress($us, $done);
    return $out;
}

/** Replace an m003 unit's tile in the store (none when the maximum is zero). */
function lumen_mig_write_mip_tile(string $store, array $unit, ?string $png): void {
    $p = lumen_mig_mip_tile_path($store, $unit);
    if ($png !== null && $png !== '') {
        if (!lumen_write_file_atomic($p, $png)) throw new LumenMigError('tile_write_failed', 500);
    } elseif (is_file($p)) {
        @unlink($p);
    }
}

/** Replace an m004 unit's bricks in the store: the given ones written, every other brick of its super-block (or octant $part) removed. */
function lumen_mig_write_unit_m004(array $us, string $store, array $unit, array $bricks, int $part = -1): void {
    [$t, $k, $c] = $unit;
    foreach (lumen_mig_m004_unit_bricks($us, $unit, $part) as [$bz, $by, $bx]) {
        $p = lumen_mig_v3_store_brick($store, $t, $k, $c, $bz, $by, $bx);
        $data = $bricks["$bz.$by.$bx"] ?? null;
        if ($data !== null && $data !== '') {
            if (!lumen_write_file_atomic($p, $data)) throw new LumenMigError('tile_write_failed', 500);
        } elseif (is_file($p)) {
            @unlink($p);
        }
    }
}

function lumen_mig_store_any(array $plan, array $us, array $unit, string $store, $result): void {
    if ($us['mid'] === LUMEN_M002) lumen_mig_write_unit_tiles($plan, LUMEN_M002, $unit, $result);
    elseif ($us['mid'] === LUMEN_M003) lumen_mig_write_mip_tile($store, $unit, $result);
    else lumen_mig_write_unit_m004($us, $store, $unit, $result);
}

/** [[bz, by, bx, webp]] of an m004 unit blob (u32 count, count × {u32 bz, by, bx, length, bytes}, LE). */
function lumen_mig_parse_v3_blob(string $body): array {
    $n = strlen($body);
    if ($n < 4) throw new LumenMigError('bad_blob');
    $count = unpack('V', substr($body, 0, 4))[1];
    if ($count > 64) throw new LumenMigError('bad_blob', 400, 'too many bricks');
    $pos = 4; $out = [];
    for ($i = 0; $i < $count; $i++) {
        if ($pos + 16 > $n) throw new LumenMigError('bad_blob', 400, 'truncated entry');
        $e = unpack('Vz/Vy/Vx/Vlen', substr($body, $pos, 16));
        $pos += 16;
        if ($pos + $e['len'] > $n) throw new LumenMigError('bad_blob', 400, 'truncated brick');
        $out[] = [$e['z'], $e['y'], $e['x'], substr($body, $pos, $e['len'])];
        $pos += $e['len'];
    }
    if ($pos !== $n) throw new LumenMigError('bad_blob', 400, 'trailing bytes');
    return $out;
}

/**
 * One uploaded v3 brick image: lossless WebP 594×528 (RIFF/VP8L), decoded: opaque, the 6
 * unused mosaic slots zero. True when its 64³ interior holds a non-zero voxel (stored),
 * false when the interior is zero (ESS: not stored). InvalidArgumentException when invalid.
 */
function lumen_mig_validate_v3_brick(string $data): bool {
    [$w, $h] = lumen_v3_webp_lossless_size($data);
    if ($w !== LUMEN_V3_MOSAIC_W || $h !== LUMEN_V3_MOSAIC_H) throw new InvalidArgumentException("brick image is {$w}x{$h}, expected 594x528");
    try {
        $img = lumen_v3_webp_decode($data, LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H);
    } catch (RuntimeException $e) {
        throw new InvalidArgumentException($e->getMessage());
    }
    // Slots 66..71 = row 7, columns 3..8.
    $off = 3 * LUMEN_V3_SLICE; $len = LUMEN_V3_MOSAIC_W - $off;
    for ($y = 7 * LUMEN_V3_SLICE; $y < LUMEN_V3_MOSAIC_H; $y++) {
        if (strspn($img, "\0", $y * LUMEN_V3_MOSAIC_W + $off, $len) !== $len) throw new InvalidArgumentException('unused mosaic slots are not zero');
    }
    return !lumen_v3_interior_zero(lumen_v3_unmosaic($img));
}

/**
 * Browser executor: store the encoded result of one unit (idempotent). Blob layouts:
 * m002 §5.1 (planes), m003 the same with the layer in place of z (≤ 1 entry), m004
 * lumen_mig_parse_v3_blob. $body null = php://input.
 */
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
    $mid = $m['id'];
    $unit = lumen_mig_parse_key_for($mid, $key);
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $mid);
    if ($mid === LUMEN_M002) [, $w, $h, $z0, $depth] = lumen_mig_unit_geometry($plan, $unit);
    elseif ($mid === LUMEN_M003) [, $w, $h] = lumen_mig_m003_unit_geometry($plan, $unit);
    $us = lumen_mig_unitset($plan, $mid);
    if ($mid === LUMEN_M004) lumen_mig_m004_check_unit($us, $plan, $unit);
    $ukey = lumen_mig_unit_key_for($mid, $unit);
    if (!isset($us['unitBytes'][$ukey])) throw new LumenMigError('empty_unit', 409);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path, false);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    $raw = $body ?? lumen_mig_read_body(false);
    if ($mid === LUMEN_M002) {
        $tiles = [];
        foreach (lumen_mig_parse_blob($raw) as [$z, $png]) {
            if ($z < $z0 || $z >= $z0 + $depth || array_key_exists($z, $tiles)) throw new LumenMigError('bad_blob', 400, "plane $z outside the unit's layer");
            try {
                $isZero = lumen_mig_png_validate($png, $w, $h);
            } catch (InvalidArgumentException $e) {
                throw new LumenMigError('bad_png', 400, "z$z: " . $e->getMessage());
            }
            $tiles[$z] = $isZero ? null : $png;
        }
        lumen_mig_write_unit_tiles($plan, $mid, $unit, array_filter($tiles, fn($p) => $p !== null));
    } elseif ($mid === LUMEN_M003) {
        $entries = lumen_mig_parse_blob($raw);
        if (count($entries) > 1) throw new LumenMigError('bad_blob', 400, 'an m003 unit holds one tile');
        $png = null;
        foreach ($entries as [$layer, $data]) {
            if ($layer !== $unit[1]) throw new LumenMigError('bad_blob', 400, "layer $layer, unit is layer {$unit[1]}");
            try {
                $png = lumen_mig_png_validate($data, $w, $h) ? null : $data;
            } catch (InvalidArgumentException $e) {
                throw new LumenMigError('bad_png', 400, "l$layer: " . $e->getMessage());
            }
        }
        lumen_mig_write_mip_tile($store, $unit, $png);
    } else {
        if (!lumen_mig_m004_level_ready($us, array_flip($j['done'] ?? []), $unit)) {
            throw new LumenMigError('unit_blocked', 409, 'a lower level of this tree/channel is not complete');
        }
        $allowed = [];
        foreach (lumen_mig_m004_unit_bricks($us, $unit) as [$bz, $by, $bx]) $allowed["$bz.$by.$bx"] = true;
        $bricks = [];
        foreach (lumen_mig_parse_v3_blob($raw) as [$bz, $by, $bx, $data]) {
            $b = "$bz.$by.$bx";
            if (!isset($allowed[$b]) || array_key_exists($b, $bricks)) throw new LumenMigError('bad_blob', 400, "brick z$bz y$by x$bx outside the unit");
            try {
                $keep = lumen_mig_validate_v3_brick($data);
            } catch (InvalidArgumentException $e) {
                throw new LumenMigError('bad_webp', 400, "z$bz y$by x$bx: " . $e->getMessage());
            }
            $bricks[$b] = $keep ? $data : null;
        }
        unset($raw);
        lumen_mig_write_unit_m004($us, $store, $unit, array_filter($bricks, fn($d) => $d !== null));
    }
    $j = lumen_mig_mark_done($plan, $m, $path, [$ukey], 'browser');
    $s = lumen_mig_summary($j);
    return ['ok' => true, 'done' => $s['done'], 'total' => $s['total']];
}

/** Server executor: process runnable units for at most ~maxSeconds (at least one step). */
function lumen_mig_unit_run($datasetId, $mid, $maxSeconds = LUMEN_MIG_MAX_RUN_S, bool $dry = false): array {
    $t0 = microtime(true);
    $budget = lumen_mig_budget($maxSeconds);
    $clock = lumen_mig_exec_clock();
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    lumen_mig_clock_step($clock);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    $us = lumen_mig_unitset($plan, $m['id']);
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $m['id']);
    // Only a request the host can kill keeps the step bookkeeping (attempts, octants).
    $track = $clock['limited'] && !$dry;
    $run = ['steps' => 0, 'slowest' => 0.0, 'read' => 0, 'written' => 0];
    $processed = []; $partial = []; $taken = [];
    while (true) {
        // Recomputed after every unit: an m004 level completing makes the next one runnable.
        [$runnable] = lumen_mig_pending_units($us, array_flip($j['done'] ?? []));
        $key = null;
        foreach ($runnable as $k => $_u) if (!isset($taken[$k])) { $key = $k; break; }
        if ($key === null) break;
        $unit = $runnable[$key];
        $taken[$key] = true;
        if ($run['steps'] && microtime(true) - $t0 + $run['slowest'] > $budget) break;
        if ($track && $us['mid'] === LUMEN_M004 && lumen_mig_should_split($j, $key, $unit[1], $clock)) {
            [$j, $complete, $stop, $parts] = lumen_mig_run_unit_parts($plan, $m, $path, $us, $unit, $key, $store, $clock, $t0, $budget, $run);
            if ($complete) $processed[] = $key;
            elseif ($parts) $partial[] = ['unit' => $key, 'parts' => $parts, 'of' => LUMEN_V3_PARTS];
            if ($stop) break;
            continue;
        }
        if ($track) {
            $left = lumen_mig_clock_step($clock);
            if ($run['steps'] && $us['mid'] === LUMEN_M004 && (float)($j['timing'][$unit[1]]['w'] ?? INF) * 1.25 > $left) break;
            $j = lumen_mig_begin_step($plan, $m, $path, $key, $us['mid'] === LUMEN_M004 ? $unit[1] : -1);
        }
        $u0 = microtime(true);
        [$result, $nread, $nwritten] = lumen_mig_process_any($plan, $us, $unit, $key, $store);
        $run['read'] += $nread;
        $run['written'] += $nwritten;
        if (!$dry) {
            lumen_mig_store_any($plan, $us, $unit, $store, $result);
            unset($result);
            $timing = ($track && $us['mid'] === LUMEN_M004) ? [$unit[1], microtime(true) - $u0] : null;
            $j = lumen_mig_mark_done($plan, $m, $path, [$key], 'server', $timing);
        }
        unset($result);
        $processed[] = $key;
        $run['steps']++;
        $run['slowest'] = max($run['slowest'], microtime(true) - $u0);
    }
    $s = lumen_mig_summary($j);
    $out = ['ok' => true, 'processed' => $processed, 'done' => $s['done'], 'total' => $s['total'],
            'seconds' => round(microtime(true) - $t0, 3), 'bytesRead' => $run['read'],
            'bytesWritten' => $run['written'], 'dry' => $dry];
    // Octants stored by this request for units it could not finish yet: progress all the same.
    if ($partial) $out['partial'] = $partial;
    return $out;
}

/**
 * Count one more server step of a unit BEFORE it starts (journal.attempts): a step that
 * dies with its request (max_execution_time, memory_limit) leaves the count up, and a
 * unit whose steps died LUMEN_MIG_MAX_ATTEMPTS times is reported as `unit_timeout`
 * instead of being retried forever — the browser executor (no time limit) is the way
 * on. After a death, every unit of that m004 level ($level ≥ 0) is split into octants.
 */
function lumen_mig_begin_step(array $plan, array $m, string $path, string $key, int $level): array {
    [$j, $prev] = lumen_mig_journal_edit($plan, $m, $path, function (array &$j) use ($key, $level) {
        $prev = (int)($j['attempts'][$key] ?? 0);
        if ($prev >= LUMEN_MIG_MAX_ATTEMPTS) return $prev;
        $j['attempts'][$key] = $prev + 1;
        if ($prev >= 1 && $level >= 0) {
            $t = is_array($j['timing'] ?? null) ? $j['timing'] : [];
            $t[$level] = array_merge(is_array($t[$level] ?? null) ? $t[$level] : [], ['slow' => true]);
            $j['timing'] = $t;
        }
        return $prev;
    });
    if ($prev >= LUMEN_MIG_MAX_ATTEMPTS) {
        throw new LumenMigError('unit_timeout', 409, "unit $key stopped its request $prev times (max_execution_time "
                                . lumen_mig_exec_limit() . ' s)', ['unit' => $key, 'attempts' => $prev]);
    }
    return $j;
}

/**
 * Whether an m004 unit runs as 8 octants: always once it has stored octants, once one of
 * its steps died, or when its level is known slow; otherwise when no whole unit of its
 * level has been timed yet, or when the slowest one (+25 %) would not fit in the time left.
 */
function lumen_mig_should_split(array $j, string $key, int $level, array $clock): bool {
    if (!empty($j['partial'][$key]) || (int)($j['attempts'][$key] ?? 0) > 0) return true;
    $t = $j['timing'][$level] ?? null;
    if (!is_array($t) || !empty($t['slow']) || !isset($t['w'])) return true;
    return (float)$t['w'] * 1.25 > lumen_mig_clock_step($clock);
}

/**
 * The octants of one m004 unit not stored yet, while the request's budget and clock
 * allow; each one stored and journalled (journal.partial) before the next starts, the
 * unit marked done once every octant holding bricks is stored.
 * @return array [journal, complete, stop (the request must end), octants stored so far]
 */
function lumen_mig_run_unit_parts(array $plan, array $m, string $path, array $us, array $unit, string $key, string $store,
                                  array &$clock, float $t0, float $budget, array &$run): array {
    $j = lumen_mig_load_journal($path) ?? [];
    $have = [];
    foreach ((array)($j['partial'][$key] ?? []) as $p) $have[(int)$p] = true;
    $real = [];
    for ($p = 0; $p < LUMEN_V3_PARTS; $p++) if (lumen_mig_m004_unit_bricks($us, $unit, $p)) $real[] = $p;
    $fresh = !array_intersect_key($have, array_flip($real));
    $stop = false; $sum = 0.0;
    foreach ($real as $p) {
        if (isset($have[$p])) continue;
        $left = lumen_mig_clock_step($clock);
        if ($run['steps']) {
            $per = (float)($j['timing'][$unit[1]]['p'] ?? 0);
            if (microtime(true) - $t0 + max($run['slowest'], $per) > $budget || $per * 1.5 > $left) { $stop = true; break; }
        }
        $j = lumen_mig_begin_step($plan, $m, $path, $key, $unit[1]);
        $s0 = microtime(true);
        [$bricks, $nread] = lumen_mig_process_unit_m004($plan, $us, $unit, $store, $p);
        lumen_mig_write_unit_m004($us, $store, $unit, $bricks, $p);
        $run['read'] += $nread;
        $run['written'] += array_sum(array_map('strlen', $bricks));
        unset($bricks);
        $dt = microtime(true) - $s0;
        $sum += $dt;
        [$j] = lumen_mig_journal_edit($plan, $m, $path, function (array &$j) use ($key, $p, $unit, $dt) {
            $parts = array_map('intval', (array)($j['partial'][$key] ?? []));
            if (!in_array($p, $parts, true)) $parts[] = $p;
            sort($parts);
            $j['partial'][$key] = $parts;
            unset($j['attempts'][$key]);
            lumen_mig_note_timing($j, $unit[1], 'p', $dt);
        });
        $have[$p] = true;
        $run['steps']++;
        $run['slowest'] = max($run['slowest'], $dt);
    }
    $stored = count(array_intersect_key($have, array_flip($real)));
    if ($stored < count($real)) return [$j, false, $stop, $stored];
    // Every octant run by THIS request: their sum bounds a whole unit's time from above.
    $j = lumen_mig_mark_done($plan, $m, $path, [$key], 'server', ($fresh && $real) ? [$unit[1], $sum] : null);
    return [$j, true, $stop, $stored];
}

/** Server executor on N sample units spread over the units runnable at a job's start (m004: level 0), results discarded. */
function lumen_mig_bench($datasetId, $n = 4, $mid = null, bool $requireServer = false): array {
    $plan = lumen_mig_plan_for($datasetId);
    $n = is_numeric($n) ? (int)$n : 4;
    $n = max(1, min(LUMEN_MIG_MAX_BENCH_UNITS, $n));
    if ($mid === null || $mid === '') {
        $fv = lumen_mig_format_version(lumen_mig_read_metadata($plan['dir']));
        $mid = LUMEN_M002;
        foreach (LUMEN_MIGRATIONS as $mm) {
            if (in_array($plan['type'], $mm['types'], true) && lumen_mig_applicable($plan, $fv, $mm)) { $mid = $mm['id']; break; }
        }
    }
    $m = lumen_mig_migration($mid);
    if ($requireServer) lumen_mig_require_server($m['id']);
    $us = lumen_mig_unitset($plan, $m['id']);
    [$runnable] = lumen_mig_pending_units($us, []);
    $keys = array_keys($runnable);
    if (!$keys) return ['ok' => true, 'migration' => $m['id'], 'seconds' => 0.0, 'units' => 0, 'bytesRead' => 0, 'bytesWritten' => 0];
    $idx = [];
    for ($k = 0; $k < min($n, count($keys)); $k++) $idx[intdiv($k * count($keys), $n)] = true;
    ksort($idx);
    $picks = array_map(fn($i) => $keys[$i], array_keys($idx));
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $m['id']);
    // A bench is one request too: it stops before max_execution_time, and where the
    // limit holds m004 is measured octant by octant (what unit_run does there), a unit
    // then counting as its share of octants run.
    $budget = lumen_mig_budget(null);
    $clock = lumen_mig_exec_clock();
    $split = $m['id'] === LUMEN_M004 && $clock['limited'];
    $t0 = microtime(true); $nread = 0; $nwritten = 0; $units = 0.0; $slowest = 0.0; $steps = 0; $used = [];
    foreach ($picks as $key) {
        $unit = $runnable[$key];
        $parts = [-1];
        if ($split) {
            $parts = [];
            for ($p = 0; $p < LUMEN_V3_PARTS; $p++) if (lumen_mig_m004_unit_bricks($us, $unit, $p)) $parts[] = $p;
        }
        foreach ($parts as $p) {
            $left = lumen_mig_clock_step($clock);
            if ($steps && $clock['limited'] && (microtime(true) - $t0 + $slowest > $budget || $slowest * 1.5 > $left)) break 2;
            $s0 = microtime(true);
            if ($p < 0) {
                [, $r, $w] = lumen_mig_process_any($plan, $us, $unit, $key, $store);
            } else {
                [$bricks, $r] = lumen_mig_process_unit_m004($plan, $us, $unit, $store, $p);
                $w = array_sum(array_map('strlen', $bricks));
                unset($bricks);
            }
            $nread += $r;
            $nwritten += $w;
            $units += 1 / count($parts);
            $steps++;
            $slowest = max($slowest, microtime(true) - $s0);
            if (!in_array($key, $used, true)) $used[] = $key;
        }
    }
    $secs = microtime(true) - $t0;
    return ['ok' => true, 'migration' => $m['id'], 'seconds' => round($secs, 3), 'units' => count($used), 'bytesRead' => $nread,
            'bytesWritten' => $nwritten, 'secondsPerUnit' => round($secs / max($units, 1e-9), 4), 'sample' => $used,
            'unitsMeasured' => round($units, 3)];
}

/**
 * The executors' speed test (twin of dataset_migrations.speedtest). A block = what a unit
 * does for each brick it reads: decode the 512² lossless-WebP mosaic of one 64³ brick and
 * encode its voxels as one 512² png-gray8 tile. The input is the synthetic brick shipped with
 * the platform (js/migrations/speedtest-brick.webp, which the browser downloads too). Blocks
 * run back to back until the next one would end past $maxSeconds (≤ 3 s, at least one block,
 * and within max_execution_time); nothing is written.
 */
function lumen_mig_speedtest($maxSeconds = 1.0): array {
    lumen_mig_require_server(LUMEN_M002);
    $budget = is_numeric($maxSeconds) ? (float)$maxSeconds : 1.0;
    $budget = max(0.05, min(LUMEN_MIG_SPEEDTEST_MAX_S, $budget));
    $raw = @file_get_contents(admin_root() . '/js/migrations/speedtest-brick.webp');
    if (!is_string($raw) || $raw === '') throw new LumenMigError('speedtest_sample_missing', 500);
    $clock = lumen_mig_exec_clock();
    $tile = LUMEN_MIG_BRICK * 8;
    $blocks = 0; $written = 0; $slowest = 0.0;
    $t0 = microtime(true);
    for (;;) {
        $left = lumen_mig_clock_step($clock);
        if ($blocks && $slowest * 1.5 > $left) break;
        $b0 = microtime(true);
        $img = lumen_mig_gd_open($raw);
        if ($img === null) throw new LumenMigError('server_unavailable', 409, 'no_webp_decode');
        try {
            $voxels = lumen_mig_gd_red($img, $tile, $tile);
        } finally {
            imagedestroy($img);
        }
        $written += strlen(lumen_mig_png_encode($voxels, $tile, $tile));
        $blocks++;
        $now = microtime(true);
        $slowest = max($slowest, $now - $b0);
        if ($now - $t0 + $slowest > $budget) break;
    }
    return ['ok' => true, 'blocks' => $blocks, 'seconds' => round(microtime(true) - $t0, 4),
            'bytesRead' => $blocks * strlen($raw), 'bytesWritten' => $written];
}

/** The browser's side of the speed test uploads each converted block here; the bytes are dropped. */
function lumen_mig_speedtest_put(?string $raw): array {
    if ($raw !== null) {
        if (strlen($raw) > LUMEN_MIG_SPEEDTEST_PUT_MAX) throw new LumenMigError('body_too_large', 413);
        return ['ok' => true, 'bytes' => strlen($raw)];
    }
    $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : -1;
    if ($declared > LUMEN_MIG_SPEEDTEST_PUT_MAX) throw new LumenMigError('body_too_large', 413);
    return ['ok' => true, 'bytes' => lumen_mig_read_body(true)];
}

/** What a browser executor reads for one unit (twin of dataset_migrations.unit_inputs). */
function lumen_mig_unit_inputs($datasetId, $mid, $key): array {
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $mid);
    $mid = $m['id'];
    $unit = lumen_mig_parse_key_for($mid, $key);
    $us = lumen_mig_unitset($plan, $mid);
    $ukey = lumen_mig_unit_key_for($mid, $unit);
    $out = ['ok' => true, 'migration' => $mid, 'unit' => $ukey, 'empty' => !isset($us['unitBytes'][$ukey])];
    $rel = function (string $p, string $base): string {
        return ltrim(str_replace('\\', '/', substr($p, strlen($base))), '/');
    };
    if ($mid === LUMEN_M003) {
        [$tree, $w, $h] = lumen_mig_m003_unit_geometry($plan, $unit);
        $tiles = [];
        foreach ($us['refs'][$ukey] ?? [] as [$z, $off, $len]) $tiles[] = ['z' => $z, 'pack' => sprintf('z%05d.bin', $z), 'offset' => $off, 'length' => $len];
        return $out + ['tree' => $tree['rel'], 'width' => $w, 'height' => $h, 'tiles' => $tiles];
    }
    if ($mid === LUMEN_M002) {
        [$tree] = lumen_mig_unit_geometry($plan, $unit);
        [, $bz, $c, $ty, $tx] = $unit;
        $rows = [];
        foreach ($tree['index'] as $k => [$p, $off, $len]) {
            [$cc, $bx, $by, $bzz] = array_map('intval', explode(':', $k));
            if ($cc === $c && $bzz === $bz && intdiv($bx, 8) === $tx && intdiv($by, 8) === $ty) {
                $rows[] = [[$cc, $bx, $by, $bzz], ['x' => $bx, 'y' => $by, 'z' => $bz, 'url' => $rel($p, $tree['bricksDir']), 'offset' => $off, 'length' => $len]];
            }
        }
        usort($rows, fn($a, $b) => $a[0] <=> $b[0]);
        return $out + ['tree' => $tree['rel'], 'bricks' => array_column($rows, 1)];
    }
    lumen_mig_m004_check_unit($us, $plan, $unit);
    [$t, $k, $c] = $unit;
    $tree = $plan['trees'][$t];
    $L = $us['levels'][$k];
    $rng = lumen_mig_m004_unit_ranges($us, $unit);
    $out += ['tree' => $tree['rel'], 'level' => $k, 'halveZ' => $L['halveZ'], 'dimensions' => $L['dimensions'],
             'range' => ['x' => $rng[0], 'y' => $rng[1], 'z' => $rng[2]],
             'outputBricks' => array_map(fn($b) => ['z' => $b[0], 'y' => $b[1], 'x' => $b[2]], lumen_mig_m004_unit_bricks($us, $unit))];
    if ($k === 0) {
        $rows = [];
        foreach (lumen_mig_bricks_overlapping($rng, $L['grid']) as [$bz, $by, $bx]) {
            $ref = $tree['index']["$c:$bx:$by:$bz"] ?? null;
            if ($ref !== null) $rows[] = ['z' => $bz, 'y' => $by, 'x' => $bx, 'url' => $rel($ref[0], $tree['bricksDir']), 'offset' => $ref[1], 'length' => $ref[2]];
        }
        return $out + ['source' => 'v2', 'bricks' => $rows];
    }
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $mid);
    $src = lumen_mig_m004_source_ranges($us, $unit);
    $rows = [];
    foreach (lumen_mig_bricks_overlapping($src, $us['levels'][$k - 1]['grid']) as [$bz, $by, $bx]) {
        $p = lumen_mig_v3_store_brick($store, $t, $k - 1, $c, $bz, $by, $bx);
        clearstatcache(true, $p);
        if (!is_file($p)) continue;
        $rows[] = ['z' => $bz, 'y' => $by, 'x' => $bx, 'key' => lumen_mig_unit_key_for(LUMEN_M004, [$t, $k - 1, $c, $bz, $by, $bx]), 'length' => (int)filesize($p)];
    }
    $j = null;
    try { $j = lumen_mig_load_journal($path); } catch (LumenMigError $e) { $j = null; }
    return $out + ['source' => 'store', 'sourceLevel' => $k - 1,
                   'sourceRange' => ['x' => $src[0], 'y' => $src[1], 'z' => $src[2]], 'bricks' => $rows,
                   'ready' => lumen_mig_m004_level_ready($us, array_flip(($j ?? [])['done'] ?? []), $unit)];
}

/**
 * One brick of the m004 tile store (a level the browser reduces from): key
 * t{t}.k{k}.c{c}.z{bz}.y{by}.x{bx} names the BRICK. 404 `absent` when not stored.
 * Returns the path (the entry point streams it).
 */
function lumen_mig_store_get_path($datasetId, $mid, $key): string {
    $m = lumen_mig_migration($mid);
    if ($m['id'] !== LUMEN_M004) throw new LumenMigError('not_applicable', 409);
    [$type, $folder] = lumen_mig_resolve($datasetId);
    [$t, $k, $c, $bz, $by, $bx] = lumen_mig_parse_key_for(LUMEN_M004, $key);
    $p = lumen_mig_v3_store_brick(lumen_mig_store_dir($type, $folder, LUMEN_M004), $t, $k, $c, $bz, $by, $bx);
    if (!is_file($p)) throw new LumenMigError('absent', 404);
    return $p;
}

// ── Kept from the format-2 engine ────────────────────────────────────────────

function lumen_mig_load_journal(string $path): ?array {
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    $d = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($d)) throw new LumenMigError('journal_corrupt', 500);
    return $d;
}

function lumen_mig_read_metadata(string $dir): array {
    $meta = admin_read_json("$dir/metadata.json");
    return is_array($meta) ? $meta : [];
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

/**
 * Read-modify-write of a running job's journal under its lock (source checked first).
 * $fn(array &$j) edits it; returns [saved journal, $fn's return value].
 */
function lumen_mig_journal_edit(array $plan, array $m, string $path, callable $fn): array {
    $base = lumen_mig_job_base($plan['type'], $plan['folder'], $m['id']);
    return lumen_mig_with_job_lock($base, function () use ($plan, $path, $fn) {
        $j = lumen_mig_load_journal($path);
        if ($j === null) throw new LumenMigError('no_job', 404);
        lumen_mig_check_source($plan, $j, $path);
        if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
        $r = $fn($j);
        lumen_mig_save_journal($path, $j);
        return [$j, $r];
    });
}

/**
 * Journal units as done by an executor (counted once per unit). A done unit's server
 * bookkeeping goes: `partial` (octants already stored) and `attempts` (steps started).
 * $timing: [level, seconds] of a whole server unit (lumen_mig_note_timing).
 */
function lumen_mig_mark_done(array $plan, array $m, string $path, array $keys, string $executor, ?array $timing = null): array {
    [$j] = lumen_mig_journal_edit($plan, $m, $path, function (array &$j) use ($keys, $executor, $timing) {
        $done = $j['done'] ?? [];
        $have = array_flip($done);
        $added = 0;
        foreach ($keys as $k) {
            if (!isset($have[$k])) { $have[$k] = true; $done[] = $k; $added++; }
            unset($j['partial'][$k], $j['attempts'][$k]);
        }
        $j['done'] = $done;
        $ex = is_array($j['executors'] ?? null) ? $j['executors'] : ['browser' => 0, 'server' => 0];
        $ex[$executor] = (int)($ex[$executor] ?? 0) + $added;
        $j['executors'] = $ex;
        if ($timing !== null) lumen_mig_note_timing($j, $timing[0], 'w', $timing[1]);
    });
    return $j;
}

/** journal.timing[level][what] = the largest seconds seen ('w' a whole unit, 'p' one octant). */
function lumen_mig_note_timing(array &$j, int $level, string $what, float $seconds): void {
    $t = is_array($j['timing'] ?? null) ? $j['timing'] : [];
    $row = is_array($t[$level] ?? null) ? $t[$level] : [];
    $row[$what] = round(max((float)($row[$what] ?? 0), $seconds), 3);
    $t[$level] = $row;
    $j['timing'] = $t;
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

// ── Finalize ─────────────────────────────────────────────────────────────────

/** Assemble, validate, swap, bump of m002 (SPEC §5.2), re-entrant; see lumen_mig_finalize. */
function lumen_mig_finalize_m002(array $m, $datasetId, float $deadline): array {
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $m['id']);
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
                    $j['assembly'] = ['planes' => $planesTotal, 'written' => lumen_mig_count_bins($plan, $incoming)];
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

/** .bin files already written under each tree's directory of an incoming structure. */
function lumen_mig_count_bins(array $plan, string $incoming): int {
    $n = 0;
    foreach ($plan['trees'] as $tr) {
        $d = $tr['rel'] === '' ? $incoming : "$incoming/{$tr['rel']}";
        foreach (@scandir($d) ?: [] as $nm) if (substr($nm, -4) === '.bin') $n++;
    }
    return $n;
}

/** Compact JSON of a written manifest (Python's separators=(',', ':'), ensure_ascii=False). */
function lumen_mig_json_bytes($doc): string {
    $json = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($json === false) throw new LumenMigError('assembly_write_failed', 500, 'json');
    return $json;
}

/** Rename the live structure aside, the incoming one in, delete the old one (planes/, mips/). Re-entrant. */
function lumen_mig_swap_dirs(string $dsDir, string $mid): void {
    [$inc, $live, $old] = LUMEN_MIG_SWAP_DIRS[$mid];
    $incoming = "$dsDir/$inc"; $l = "$dsDir/$live"; $o = "$dsDir/$old";
    if (is_dir($incoming)) {
        if (file_exists($l)) {
            lumen_mig_rrmdir($o);
            if (!@rename($l, $o)) throw new LumenMigError('swap_failed', 500);
        }
        if (!@rename($incoming, $l)) {
            if (is_dir($o) && !file_exists($l)) @rename($o, $l);
            throw new LumenMigError('swap_failed', 500);
        }
    }
    lumen_mig_rrmdir($o);
}

/** The layer packs of one tree into .mips-incoming (SPEC §12); false when the deadline stopped it. */
function lumen_mig_assemble_mips_tree(array $plan, array $us, array $tree, string $store, string $incoming, string $producer, string $createdAt, ?float $deadline): bool {
    $out = $tree['rel'] === '' ? $incoming : "$incoming/{$tree['rel']}";
    if (!is_dir($plan['dir'])) throw new LumenMigError('no_dataset', 404);
    if (!admin_make_dir($out)) throw new LumenMigError('assembly_write_failed', 500);
    $present = array_flip(@scandir($out) ?: []);
    $C = $tree['C']; $TX = $tree['TX']; $TY = $tree['TY'];
    $hb = 16 + 12 * $C * $TY * $TX;
    $wrote = false;
    for ($l = 0, $nl = intdiv($tree['Z'] + 63, 64); $l < $nl; $l++) {
        $name = sprintf('l%05d.bin', $l);
        if (isset($present[$name])) continue;
        if ($wrote && $deadline !== null && microtime(true) > $deadline) return false;
        if (!is_dir($out)) throw new LumenMigError('no_dataset', 404);
        $head = LUMEN_MIPS_MAGIC . pack('vvvvV', 1, $C, $TX, $TY, $l);
        $payloads = []; $off = $hb;
        for ($c = 0; $c < $C; $c++) for ($ty = 0; $ty < $TY; $ty++) {
            $h = min(LUMEN_MIG_TILE, $tree['Y'] - $ty * LUMEN_MIG_TILE);
            for ($tx = 0; $tx < $TX; $tx++) {
                $w = min(LUMEN_MIG_TILE, $tree['X'] - $tx * LUMEN_MIG_TILE);
                $u = [$tree['t'], $l, $c, $ty, $tx];
                $payload = '';
                if (isset($us['unitBytes'][lumen_mig_unit_key_for(LUMEN_M003, $u)])) {
                    $p = lumen_mig_mip_tile_path($store, $u);
                    if (is_file($p)) {
                        $payload = (string)@file_get_contents($p);
                        if ($payload !== '' && lumen_mig_png_ihdr($payload) !== [$w, $h, 8, 0, 0, 0, 0]) {
                            throw new LumenMigError('bad_tile', 500, basename($p) . " l$l: IHDR");
                        }
                    }
                }
                $len = strlen($payload);
                $head .= pack('PV', $len ? $off : 0, $len);
                if ($len) { $payloads[] = $payload; $off += $len; }
            }
        }
        if (!lumen_write_file_atomic("$out/$name", $head . implode('', $payloads))) throw new LumenMigError('assembly_write_failed', 500);
        $wrote = true;
    }
    if (!lumen_write_file_atomic("$out/manifest.json", lumen_mig_json_bytes(lumen_mig_mips_manifest($tree, $plan['sha'], $producer, $createdAt)))) {
        throw new LumenMigError('assembly_write_failed', 500);
    }
    return true;
}

/** Assemble mips/, validate, swap, bump to 3 — m002's state machine. */
function lumen_mig_finalize_m003(array $m, $datasetId, float $deadline): array {
    [$m, $plan, $path] = lumen_mig_open_job($datasetId, $m['id']);
    $base = lumen_mig_job_base($plan['type'], $plan['folder'], $m['id']);
    return lumen_mig_with_job_lock($base, function () use ($m, $plan, $path, $deadline) {
        $j = lumen_mig_load_journal($path);
        if ($j === null) {
            if (in_array($plan['type'], $m['types'], true) && lumen_mig_mips_valid($plan)) {
                return ['ok' => true, 'complete' => true, 'formatVersion' => lumen_mig_bump_metadata($plan['dir'], $m['to'])];
            }
            throw new LumenMigError('no_job', 404);
        }
        $state = $j['state'] ?? null;
        if ($state === 'running' || $state === 'assembling') lumen_mig_check_source($plan, $j, $path);
        if ($state === 'running') {
            $us = lumen_mig_unitset($plan, LUMEN_M003);
            $done = array_flip($j['done'] ?? []);
            $missing = 0;
            foreach ($us['units'] as $k => $_u) if (!isset($done[$k])) $missing++;
            if ($missing) throw new LumenMigError('units_pending', 409, "$missing unit(s) not done");
            lumen_mig_rrmdir($plan['dir'] . '/.mips-incoming');
            $j['state'] = 'assembling';
            $j['producer'] = lumen_mig_producer($j);
            $j['assembledAt'] = lumen_mig_now();
            lumen_mig_save_journal($path, $j);
            $state = 'assembling';
        }
        if ($state === 'assembling') {
            $us = lumen_mig_unitset($plan, LUMEN_M003);
            $store = lumen_mig_store_dir($plan['type'], $plan['folder'], $m['id']);
            $incoming = $plan['dir'] . '/.mips-incoming';
            $layers = 0;
            foreach ($plan['trees'] as $tree) $layers += intdiv($tree['Z'] + 63, 64);
            $ts = array_keys($plan['trees']);
            sort($ts);
            foreach ($ts as $t) {
                if (!lumen_mig_assemble_mips_tree($plan, $us, $plan['trees'][$t], $store, $incoming,
                                                  $j['producer'] ?? lumen_mig_producer($j), $j['assembledAt'] ?? lumen_mig_now(), $deadline)) {
                    $j['assembly'] = ['layers' => $layers, 'written' => lumen_mig_count_bins($plan, $incoming)];
                    lumen_mig_save_journal($path, $j);
                    return ['ok' => true, 'complete' => false, 'assembly' => $j['assembly']];
                }
            }
            if (!lumen_mig_mips_valid($plan, '.mips-incoming')) throw new LumenMigError('assembly_invalid', 500);
            lumen_mig_check_source($plan, $j, $path);
            lumen_mig_swap_dirs($plan['dir'], LUMEN_M003);
            $j['state'] = 'swapped';
            unset($j['assembly']);
            lumen_mig_save_journal($path, $j);
            $state = 'swapped';
        }
        if ($state === 'swapped') {
            lumen_mig_swap_dirs($plan['dir'], LUMEN_M003);
            if (!lumen_mig_mips_valid($plan)) {
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

function lumen_mig_bricks_dir_schema(string $d) {
    $doc = admin_read_json("$d/manifest.json");
    return is_array($doc) ? ($doc['schema'] ?? null) : null;
}

/** bricks/ → bricks.v2-old/, .bricks-incoming/ → bricks/ (SPEC §13.6); re-entrant. */
function lumen_mig_swap_bricks(string $ds): void {
    $incoming = "$ds/.bricks-incoming"; $live = "$ds/bricks"; $old = "$ds/bricks.v2-old";
    if (!is_dir($incoming)) return;
    if (file_exists($live)) {
        if (lumen_mig_bricks_dir_schema($live) === LUMEN_V3_SCHEMA) { lumen_mig_rrmdir($incoming); return; }
        lumen_mig_rrmdir($old);   // a stale leftover: the live v2 tree is the one to keep aside
        if (!@rename($live, $old)) throw new LumenMigError('swap_failed', 500);
    }
    if (!@rename($incoming, $live)) throw new LumenMigError('swap_failed', 500);
}

/** Re-stamp planes/ and mips/ manifests made from the v2 bricks ($oldSha) with the v3 manifest's sha256. */
function lumen_mig_restamp_derived(array $plan, ?string $oldSha): int {
    $n = 0;
    foreach ($plan['trees'] as $tree) {
        foreach (['planes', 'mips'] as $root) {
            $p = lumen_mig_tree_planes_dir($plan['dir'], $tree, $root) . '/manifest.json';
            $doc = is_file($p) ? json_decode((string)@file_get_contents($p), true) : null;
            if (!is_array($doc) || !is_array($doc['source'] ?? null)) continue;
            $cur = $doc['source']['manifestSha256'] ?? null;
            if ($cur === $plan['sha'] || $oldSha === null || $cur !== $oldSha) continue;
            $doc['source']['manifestSha256'] = $plan['sha'];
            if (!lumen_write_file_atomic($p, lumen_mig_json_bytes($doc))) throw new LumenMigError('assembly_write_failed', 500);
            $n++;
        }
    }
    return $n;
}

/** Brick-order rows of one (t, k, c) of the store: [[name, size]…] (0 = absent), its pack layout, pack count and write order. */
function lumen_mig_v3_layout(array $L, string $dir): array {
    [$gx, $gy, $gz] = $L['grid'];
    $sizes = [];
    foreach (@scandir($dir) ?: [] as $nm) if (substr($nm, -5) === '.webp' && is_file("$dir/$nm")) $sizes[$nm] = (int)filesize("$dir/$nm");
    $rows = [];
    for ($bz = 0; $bz < $gz; $bz++) for ($by = 0; $by < $gy; $by++) for ($bx = 0; $bx < $gx; $bx++) {
        $nm = "z$bz.y$by.x$bx.webp";
        $rows[] = [$nm, $sizes[$nm] ?? 0];
    }
    [$layout, $npacks, $order] = lumen_v3_pack_layout(array_column($rows, 1), $L['grid']);
    return [$rows, $layout, $npacks, $order];
}

/**
 * Write the packs, index.bin and manifest.json of the v3 tree(s) into .bricks-incoming
 * (SPEC §13.3/§13.4). A pack already written with its expected size is kept, so the
 * deadline only pauses it (at least one pack per call). [complete, written, total].
 */
function lumen_mig_assemble_v3(array $plan, array $us, string $store, string $incoming, array $j, ?float $deadline): array {
    if (!is_dir($plan['dir'])) throw new LumenMigError('no_dataset', 404);
    $ts = array_keys($plan['trees']);
    sort($ts);
    $C = $plan['trees'][$ts[0]]['C'];
    $layouts = []; $total = 0;
    foreach ($ts as $t) foreach ($us['levels'] as $k => $L) for ($c = 0; $c < $C; $c++) {
        $layouts["$t:$k:$c"] = lumen_mig_v3_layout($L, "$store/t$t/k$k/c$c");
        $total += $layouts["$t:$k:$c"][2];
    }
    $written = 0; $wroteNow = false; $refs = []; $stored = array_fill(0, count($us['levels']), 0);
    foreach ($ts as $t) {
        $tree = $plan['trees'][$t];
        $out = $tree['rel'] === '' ? $incoming : "$incoming/{$tree['rel']}";
        $levelsHead = []; $entries = '';
        foreach ($us['levels'] as $k => $L) {
            $packs = 0;
            for ($c = 0; $c < $C; $c++) {
                [$rows, $layout, $npacks, $order] = $layouts["$t:$k:$c"];
                $packs += $npacks;
                $stored[$k] += count($order);
                $members = array_fill(0, $npacks, []);
                foreach ($order as $i) $members[$layout[$i][0]][] = $rows[$i];
                $dir = "$store/t$t/k$k/c$c";
                for ($pk = 0; $pk < $npacks; $pk++) {
                    $dest = "$out/" . lumen_v3_pack_rel($k, $c, $pk);
                    $expected = array_sum(array_column($members[$pk], 1));
                    clearstatcache(true, $dest);
                    if (is_file($dest) && filesize($dest) === $expected) { $written++; continue; }
                    if ($wroteNow && $deadline !== null && microtime(true) > $deadline) return [false, $written, $total];
                    $parts = [];
                    foreach ($members[$pk] as [$nm, $len]) {
                        $data = (string)@file_get_contents("$dir/$nm");
                        if (strlen($data) !== $len) throw new LumenMigError('bad_tile', 500, "$nm: changed during assembly");
                        try {
                            if (lumen_v3_webp_lossless_size($data) !== [LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H]) throw new InvalidArgumentException('size');
                        } catch (InvalidArgumentException $e) {
                            throw new LumenMigError('bad_tile', 500, "k$k c$c $nm: " . $e->getMessage());
                        }
                        $parts[] = $data;
                    }
                    if (!is_dir($plan['dir'])) throw new LumenMigError('no_dataset', 404);
                    if (!admin_make_dir(dirname($dest)) || !lumen_write_file_atomic($dest, implode('', $parts))) throw new LumenMigError('assembly_write_failed', 500);
                    unset($parts);
                    $written++;
                    $wroteNow = true;
                }
                foreach ($layout as [$pk, $off, $len]) $entries .= pack('vVV', $pk, $off, $len);
            }
            $levelsHead[] = [$L['grid'][0], $L['grid'][1], $L['grid'][2], $packs];
        }
        $data = lumen_v3_index_head($levelsHead, $C) . $entries;
        unset($entries);
        if (!admin_make_dir($out) || !lumen_write_file_atomic("$out/index.bin", $data)) throw new LumenMigError('assembly_write_failed', 500);
        $refs[$tree['rel']] = ['bytes' => strlen($data), 'sha256' => hash('sha256', $data)];
    }
    $carry = $plan['carry'] ?? ['histograms' => null, 'dataset' => null, 'tph' => []];
    $live = false;
    foreach ($plan['trees'] as $tr) if ($tr['rel'] !== '') $live = true;
    $live = $live && $plan['type'] === 'live';
    $rows = [];
    foreach ($us['levels'] as $k => $L) {
        $rows[] = ['level' => $k, 'dimensions' => $L['dimensions'], 'voxelSize' => $L['voxelSize'],
                   'gridSize' => ['x' => $L['grid'][0], 'y' => $L['grid'][1], 'z' => $L['grid'][2]], 'brickCount' => $stored[$k]];
    }
    $doc = ['schema' => LUMEN_V3_SCHEMA, 'version' => 3, 'formatVersion' => 4];
    if (is_string($carry['dataset']) && $carry['dataset'] !== '') $doc['dataset'] = $carry['dataset'];
    $doc += ['channels' => $C, 'brickSize' => LUMEN_MIG_BRICK, 'apron' => LUMEN_V3_APRON,
             'brickPacking' => ['mode' => 'grid', 'cols' => LUMEN_V3_COLS, 'rows' => LUMEN_V3_ROWS, 'slice' => LUMEN_V3_SLICE],
             'encoding' => 'webp-lossless', 'levels' => $rows];
    $tph = [];
    if ($live) {
        $tps = [];
        foreach ($ts as $t) {
            $rel = $plan['trees'][$t]['rel'];
            $tps[] = ['path' => $rel, 'index' => ['url' => "$rel/index.bin"] + $refs[$rel]];
            if (isset($carry['tph'][$rel])) $tph[$rel] = json_decode($carry['tph'][$rel]);
        }
        $doc['timepoints'] = $tps;
    } else {
        $doc['timepoints'] = null;
        $doc['index'] = ['url' => 'index.bin'] + $refs[''];
    }
    $doc['histograms'] = $carry['histograms'] !== null ? json_decode($carry['histograms']) : [];
    if ($tph) $doc['timepointHistograms'] = (object)$tph;
    $doc['producer'] = $j['producer'] ?? lumen_mig_producer($j);
    $doc['createdAt'] = $j['assembledAt'] ?? lumen_mig_now();
    if (!lumen_write_file_atomic("$incoming/manifest.json", lumen_mig_json_bytes($doc))) throw new LumenMigError('assembly_write_failed', 500);
    return [true, $written, $total];
}

/**
 * Assemble the v3 tree, validate, swap bricks/, re-stamp planes/ and mips/, bump to 4,
 * delete bricks.v2-old/ (SPEC §13.6). Re-entrant at every step.
 */
function lumen_mig_finalize_m004(array $m, $datasetId, float $deadline): array {
    [$type, $folder, $ds] = lumen_mig_resolve($datasetId);
    $path = lumen_mig_journal_path($type, $folder, LUMEN_M004);
    $base = lumen_mig_job_base($type, $folder, LUMEN_M004);
    $incoming = "$ds/.bricks-incoming"; $live = "$ds/bricks"; $old = "$ds/bricks.v2-old";
    return lumen_mig_with_job_lock($base, function () use ($m, $datasetId, $type, $folder, $ds, $path, $deadline, $incoming, $live, $old) {
        $j = lumen_mig_load_journal($path);
        if ($j === null) {
            $plan = lumen_mig_plan_for($datasetId);
            if (in_array($plan['type'], $m['types'], true) && lumen_mig_bricks_v3_valid($plan)) {
                $oldSha = is_file("$old/manifest.json") ? hash_file('sha256', "$old/manifest.json") : null;
                lumen_mig_restamp_derived($plan, $oldSha);
                $fv = lumen_mig_bump_metadata($ds, $m['to']);
                lumen_mig_rrmdir($old);
                return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
            }
            throw new LumenMigError('no_job', 404);
        }
        $state = $j['state'] ?? null;
        if ($state === 'assembling' && is_dir($incoming) && (!file_exists($live) || lumen_mig_bricks_dir_schema($live) === LUMEN_V3_SCHEMA)) {
            $state = 'swapped';        // the swap ran (or half ran) but its journal entry was not written
        } elseif ($state === 'assembling' && !is_dir($incoming) && lumen_mig_bricks_dir_schema($live) === LUMEN_V3_SCHEMA) {
            $state = 'swapped';
        }
        $plan = null;
        if ($state === 'running' || $state === 'assembling') {
            $plan = lumen_mig_plan_for($datasetId);
            lumen_mig_check_source($plan, $j, $path);
        }
        if ($state === 'running') {
            $us = lumen_mig_unitset($plan, LUMEN_M004);
            $done = array_flip($j['done'] ?? []);
            $missing = 0;
            foreach ($us['units'] as $k => $_u) if (!isset($done[$k])) $missing++;
            if ($missing) throw new LumenMigError('units_pending', 409, "$missing unit(s) not done");
            lumen_mig_rrmdir($incoming);
            $j['state'] = 'assembling';
            $j['producer'] = lumen_mig_producer($j);
            $j['assembledAt'] = lumen_mig_now();
            lumen_mig_save_journal($path, $j);
            $state = 'assembling';
        }
        if ($state === 'assembling') {
            $us = lumen_mig_unitset($plan, LUMEN_M004);
            $store = lumen_mig_store_dir($type, $folder, LUMEN_M004);
            [$complete, $written, $total] = lumen_mig_assemble_v3($plan, $us, $store, $incoming, $j, $deadline);
            if (!$complete) {
                $j['assembly'] = ['packs' => $total, 'written' => $written];
                lumen_mig_save_journal($path, $j);
                return ['ok' => true, 'complete' => false, 'assembly' => $j['assembly']];
            }
            $problem = null;
            try {
                $doc = admin_read_json("$incoming/manifest.json");
                if (!is_array($doc)) throw new InvalidArgumentException('manifest');
                [, $problem] = lumen_mig_build_v3_trees($type, $incoming, $doc);
            } catch (InvalidArgumentException $e) {
                $problem = $e->getMessage();
            }
            if ($problem !== null) throw new LumenMigError('assembly_invalid', 500, $problem);
            lumen_mig_check_source($plan, $j, $path);
            $j['oldManifestSha'] = $plan['sha'];
            lumen_mig_swap_bricks($ds);
            $j['state'] = 'swapped';
            unset($j['assembly']);
            lumen_mig_save_journal($path, $j);
            $state = 'swapped';
        }
        if ($state === 'swapped') {
            lumen_mig_swap_bricks($ds);
            if (($j['state'] ?? null) !== 'swapped') {
                $j['state'] = 'swapped';
                lumen_mig_save_journal($path, $j);
            }
            $plan = lumen_mig_plan_for($datasetId);
            if (!lumen_mig_bricks_v3_valid($plan)) {
                $j['state'] = 'failed';
                $j['error'] = 'assembly_invalid';
                lumen_mig_save_journal($path, $j);
                throw new LumenMigError('assembly_invalid', 500, $plan['v3Problem']);
            }
            $oldSha = $j['oldManifestSha'] ?? null;
            if ($oldSha === null) { $src = (array)($j['sourceManifests'] ?? []); $oldSha = $src ? reset($src) : null; }
            if ($oldSha === null && is_file("$old/manifest.json")) $oldSha = hash_file('sha256', "$old/manifest.json");
            lumen_mig_restamp_derived($plan, $oldSha);
            $fv = lumen_mig_bump_metadata($ds, $m['to']);
            lumen_mig_rrmdir($old);
            lumen_mig_rrmdir(lumen_mig_store_dir($type, $folder, LUMEN_M004));
            @unlink($path);
            return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
        }
        throw new LumenMigError('job_failed', 409, (string)($j['error'] ?? $state));
    });
}

/**
 * Assemble, validate, swap, bump (SPEC §5.2, §12, §13.6). Re-entrant at every step and
 * always time-bounded here (a shared host kills a request at max_execution_time):
 * `complete: false` + `assembly` means "call again".
 */
function lumen_mig_finalize($datasetId, $mid, $maxSeconds = null): array {
    $deadline = microtime(true) + lumen_mig_budget($maxSeconds ?? LUMEN_MIG_MAX_RUN_S);
    $m = lumen_mig_migration($mid);
    $met = (int)ini_get('max_execution_time');
    if ($met > 0) @set_time_limit($met);
    if ($m['id'] === LUMEN_M003) return lumen_mig_finalize_m003($m, $datasetId, $deadline);
    if ($m['id'] === LUMEN_M004) return lumen_mig_finalize_m004($m, $datasetId, $deadline);
    return lumen_mig_finalize_m002($m, $datasetId, $deadline);
}

function lumen_mig_cancel($datasetId, $mid): array {
    $m = lumen_mig_migration($mid);
    // A dataset deleted mid-job must still let the operator drop its journal and tiles.
    [$type, $folder, $dir] = lumen_mig_resolve($datasetId, false);
    $base = lumen_mig_job_base($type, $folder, $m['id']);
    [$inc, $liveName, $oldName] = LUMEN_MIG_SWAP_DIRS[$m['id']];
    lumen_mig_with_job_lock($base, function () use ($type, $folder, $dir, $m, $inc, $liveName, $oldName) {
        $path = lumen_mig_journal_path($type, $folder, $m['id']);
        $j = null;
        try { $j = lumen_mig_load_journal($path); } catch (LumenMigError $e) { }
        // The new structure is live already: finishing is the only consistent exit.
        if ($j !== null && ($j['state'] ?? null) === 'swapped') throw new LumenMigError('finalize_in_progress', 409);
        if ($m['id'] === LUMEN_M004 && !file_exists("$dir/$liveName")) {
            if (is_dir("$dir/$inc")) throw new LumenMigError('finalize_in_progress', 409);
            if (is_dir("$dir/$oldName")) @rename("$dir/$oldName", "$dir/$liveName");
        }
        lumen_mig_rrmdir(lumen_mig_store_dir($type, $folder, $m['id']));
        lumen_mig_rrmdir("$dir/$inc");
        @unlink($path);
        return null;
    });
    @unlink(lumen_mig_root() . "/$base.lock");
    return ['ok' => true];
}

// ── Status ───────────────────────────────────────────────────────────────────

function lumen_mig_estimate_for(array $plan, array $m, ?array $j): array {
    try {
        $us = lumen_mig_unitset($plan, $m['id']);
    } catch (LumenMigError $e) {
        if ($m['id'] === LUMEN_M003 && $e->codeName === 'planes_missing') return lumen_mig_m003_estimate($plan);
        return ['units' => 0, 'bytes' => 0, 'unitsTotal' => 0, 'bytesTotal' => 0, 'exact' => false, 'error' => $e->codeName];
    }
    $done = array_flip(($j ?? [])['done'] ?? []);
    $units = 0; $bytes = 0;
    foreach ($us['unitBytes'] as $k => $b) if (!isset($done[$k])) { $units++; $bytes += $b; }
    return ['units' => $units, 'bytes' => $bytes, 'unitsTotal' => count($us['unitBytes']), 'bytesTotal' => array_sum($us['unitBytes']), 'exact' => true];
}

/**
 * One dataset row of `status` (twin of dataset_migrations.dataset_status): version,
 * pending migrations in order (a missing or invalid structure the version claims is a
 * pending repair), the jobs, and an estimate summed over the pending migrations
 * (estimate.migrations[id] each; m003 before planes/ exists is an upper bound).
 */
function lumen_mig_dataset_status(string $type, string $folder, string $dir): array {
    $meta = lumen_mig_read_metadata($dir);
    $fv = lumen_mig_format_version($meta);
    $row = ['id' => "$type/$folder", 'type' => $type, 'folder' => $folder,
            'name' => (is_string($meta['name'] ?? null) && $meta['name'] !== '') ? $meta['name'] : $folder,
            'formatVersion' => $fv, 'pending' => [], 'repair' => false, 'trees' => 0, 'job' => null, 'jobs' => [],
            'estimate' => ['units' => 0, 'bytes' => 0]];
    if (!in_array($type, LUMEN_VOLUME_DATASET_TYPES, true)) return $row;
    try {
        $plan = lumen_mig_plan_for($row['id']);
    } catch (LumenMigError $e) {
        $row['problem'] = $e->codeName;
        if ($e->detail !== null) $row['problemDetail'] = substr($e->detail, 0, 300);
        foreach (LUMEN_MIGRATIONS as $m) {
            try { $j = lumen_mig_load_journal(lumen_mig_journal_path($type, $folder, $m['id'])); } catch (LumenMigError $e2) { $j = null; }
            if ($j !== null) $row['jobs'][] = lumen_mig_summary($j);
        }
        $row['job'] = $row['jobs'][0] ?? null;
        return $row;
    }
    $row['trees'] = count($plan['trees']);
    $row['bricksSchema'] = !empty($plan['v3']) ? LUMEN_V3_SCHEMA : 'iribhm-bricks-v2';
    if (!empty($plan['v3']) && $plan['v3Problem'] !== null) {
        $row['problem'] = 'bricks_v3_invalid';
        $row['problemDetail'] = substr($plan['v3Problem'], 0, 300);
    }
    $est = ['units' => 0, 'bytes' => 0, 'unitsTotal' => 0, 'bytesTotal' => 0, 'migrations' => []];
    foreach (LUMEN_MIGRATIONS as $m) {
        if (!in_array($plan['type'], $m['types'], true)) continue;
        try {
            $j = lumen_mig_load_journal(lumen_mig_journal_path($type, $folder, $m['id']));
        } catch (LumenMigError $e) {
            $j = ['migration' => $m['id'], 'state' => 'failed', 'error' => 'journal_corrupt'];
        }
        $repair = lumen_mig_repair_needed($plan, $fv, $m);
        $pending = $m['from'] >= $fv || $repair;
        if ($m['id'] === LUMEN_M004 && !empty($plan['v3']) && $fv >= $m['to']) $pending = false;
        if ($pending) {
            $row['pending'][] = $m['id'];
            $row['repair'] = $row['repair'] || $repair;
        }
        if ($j !== null) {
            $us = null;
            if (in_array($j['state'] ?? null, ['running', 'assembling'], true)) {
                try { $us = lumen_mig_unitset($plan, $m['id']); } catch (LumenMigError $e) { $us = null; }
            }
            $row['jobs'][] = lumen_mig_summary($j, $us);
        }
        if ($pending) {
            $e = lumen_mig_estimate_for($plan, $m, $j);
            $est['migrations'][$m['id']] = $e;
            foreach (['units', 'bytes', 'unitsTotal', 'bytesTotal'] as $k) $est[$k] += (int)($e[$k] ?? 0);
        }
    }
    if ($row['jobs']) $row['job'] = $row['jobs'][0];
    if ($row['pending']) {
        $row['estimate'] = $est;
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

const LUMEN_MIG_WRITE_ACTIONS = ['plan', 'unit_put', 'unit_run', 'finalize', 'cancel', 'bench', 'unit_inputs', 'speedtest', 'speedtest_put'];
/** Binary answers (application/octet-stream) — routed to lumen_mig_handle_binary. */
const LUMEN_MIG_BINARY_ACTIONS = ['store_get'];

function lumen_mig_error_payload(LumenMigError $e): array {
    $payload = ['error' => $e->codeName] + $e->extra;
    if ($e->detail !== null && $e->detail !== $e->codeName) $payload['detail'] = substr($e->detail, 0, 500);
    return $payload;
}

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
                lumen_mig_migration($body['migration'] ?? null);
                lumen_mig_require_server($body['migration'] ?? null);
                return [200, lumen_mig_unit_run($body['dataset'] ?? null, $body['migration'] ?? null,
                                                $body['maxSeconds'] ?? LUMEN_MIG_MAX_RUN_S, !empty($body['dry']))];
            case 'finalize':
                return [200, lumen_mig_finalize($body['dataset'] ?? null, $body['migration'] ?? null, $body['maxSeconds'] ?? null)];
            case 'cancel':
                return [200, lumen_mig_cancel($body['dataset'] ?? null, $body['migration'] ?? null)];
            case 'bench':
                return [200, lumen_mig_bench($body['dataset'] ?? null, $body['units'] ?? 4, $body['migration'] ?? null, true)];
            case 'unit_inputs':
                return [200, lumen_mig_unit_inputs($body['dataset'] ?? null, $body['migration'] ?? null, $body['unit'] ?? null)];
            case 'speedtest':
                return [200, lumen_mig_speedtest($body['maxSeconds'] ?? 1.0)];
            case 'speedtest_put':
                return [200, lumen_mig_speedtest_put($raw)];
        }
        return [400, ['error' => 'unknown_action']];
    } catch (LumenMigError $e) {
        return [$e->status, lumen_mig_error_payload($e)];
    }
}

/**
 * A binary API call → [HTTP status, Content-Type, body string|null, file path|null]
 * (twin of dataset_migrations.handle_binary). store_get answers a file path the entry
 * point streams (a brick is ≤ ~1 MB, but never buffered twice); errors are JSON.
 */
function lumen_mig_handle_binary(string $action, array $params): array {
    try {
        if ($action === 'store_get') {
            return [200, 'application/octet-stream', null,
                    lumen_mig_store_get_path($params['dataset'] ?? null, $params['migration'] ?? null, $params['brick'] ?? null)];
        }
        return [400, 'application/json', '{"error":"unknown_action"}', null];
    } catch (LumenMigError $e) {
        return [$e->status, 'application/json', json_encode(lumen_mig_error_payload($e)), null];
    }
}
