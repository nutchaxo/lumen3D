<?php
/**
 * Lumen3D — format 5 and the migration m005-matrix (PHP twin, SPEC §14).
 * ======================================================================
 * Twin of format5.py (what this host needs of it) and of the m005 section of
 * dataset_migrations.py. A PHP host has no executor of its own for m005 (no numpy, no
 * lossy WebP encoder in GD worth matching): the browser computes every unit from what
 * `unit_inputs` names and posts it through `unit_put`; this file plans the units, serves
 * their inputs (`read_ranges`, `@store/A/…` included), checks and stores what comes back,
 * and assembles the v5 tree at finalize, byte for byte the Python assembly of the same
 * store. It also reads a v5 tree (status, repairs of planes/ and mips/ from its native
 * lossless bricks).
 *
 * Units (key → tuple [s, t, k, c, a, b, d], SPEC §14.10):
 *   A.t{t}.c{c}.z{z}               [0, t, 0, c, z, 0, 0]   one native plane → every level ≥ 1
 *   B.t.k.c.z{BZ}.y{BY}.x{BX}      [1, t, k, c, BZ, BY, BX] a 4×4×4 brick super-block
 *   C.t.k.c.{xz|yz}.b{b}           [2, t, k, c, 0|1, b, 0]  64 rows (columns) of XZ (YZ) cuts
 *   D.t.k.c.z{SZ}.y{SY}.x{SX}      [3, t, k, c, SZ, SY, SX] an 8×8×8 cut-brick super-block
 * A level-k ≥ 1 unit of B, C or D waits for every A unit of its tree and channel.
 *
 * Included by _migrations_lib.php (leading underscore ⇒ denied over HTTP).
 */
declare(strict_types=1);

const LUMEN_M005 = 'm005-matrix';
const LUMEN_V5_SCHEMA = 'iribhm-bricks-v5';
const LUMEN_V5_MIN_TARGET = 256;
const LUMEN_V5_COLUMN_IDS = ['ll', 'b2', 'b4', 'q80', 'q50'];
// Format 6 (SPEC §15, format5.SCHEMA_V6 / FORMAT_COLUMNS): the same tree, two columns.
const LUMEN_V6_SCHEMA = 'iribhm-bricks-v6';
const LUMEN_V6_COLUMN_IDS = ['ll', 'q30'];
const LUMEN_V5_FORMAT_COLUMNS = [5 => LUMEN_V5_COLUMN_IDS, 6 => LUMEN_V6_COLUMN_IDS];
const LUMEN_V5_FORMAT_SCHEMAS = [5 => LUMEN_V5_SCHEMA, 6 => LUMEN_V6_SCHEMA];
const LUMEN_V5_SUPER = 4;
const LUMEN_V5_ORTH_ROWS = 64;
const LUMEN_V5_ORTH_MAGIC = ['xz' => 'LPXZ', 'yz' => 'LPYZ'];
const LUMEN_V5_ORTH_HEADER = 20;
const LUMEN_V5_CUT_XY = 32;
const LUMEN_V5_CUT_SUPER = 8;
const LUMEN_V5_CUT_RECORD_HEAD = 4096;          // 512 × (u32 offset, u32 length)
const LUMEN_V5_CUT_PACK_MAX_BYTES = 16777216;
const LUMEN_V5_DEAD_ZONE_MAX = 12;
const LUMEN_V5_TAG_B4 = 0xFE;
const LUMEN_V5_TAG_LL = 0xFF;
const LUMEN_V5_MOSAIC80_W = 720;
const LUMEN_V5_MOSAIC80_H = 640;
// Bytes of a format-5 tree per byte of the format-4 level 0 (dataset_migrations.FORMAT5_SIZE_RATIO).
const LUMEN_V5_SIZE_RATIO = 7.0;
const LUMEN_M005_STAGES = 'ABCD';
const LUMEN_M005_ORTH = ['xz', 'yz'];

// ── Format 5 geometry (format5.py) ───────────────────────────────────────────

/** format5.level_ladder: level 0 native, then T = 256·2^j < max(X, Y), largest first; Z kept. */
function lumen_v5_ladder(int $X, int $Y, int $Z, $voxel): array {
    if ($X < 1 || $Y < 1 || $Z < 1) throw new InvalidArgumentException('level_ladder: empty volume');
    [$vx, $vy, $vz] = lumen_v3_usable_voxel($voxel);
    $N = max($X, $Y);
    $targets = [];
    for ($T = LUMEN_V5_MIN_TARGET; $T < $N; $T *= 2) $targets[] = $T;
    $row = function (int $k, $target, int $x, int $y) use ($X, $Y, $Z, $vx, $vy, $vz): array {
        return ['level' => $k, 'target' => $target,
                'dimensions' => ['x' => $x, 'y' => $y, 'z' => $Z],
                'voxelSize' => ['x' => $vx * $X / $x, 'y' => $vy * $Y / $y, 'z' => $vz],
                'gridSize' => ['x' => intdiv($x + 63, 64), 'y' => intdiv($y + 63, 64), 'z' => intdiv($Z + 63, 64)]];
    };
    $out = [$row(0, 'native', $X, $Y)];
    foreach (array_reverse($targets) as $T) {
        $x = $X === $N ? $T : max(1, intdiv(2 * $X * $T + $N, 2 * $N));
        $y = $Y === $N ? $T : max(1, intdiv(2 * $Y * $T + $N, 2 * $N));
        $out[] = $row(count($out), $T, $x, $y);
    }
    return $out;
}

/** format5.cut_depth: bz = 2^round(log2(32·max(vx, vy) / vz)) clamped to [1, 32]. */
function lumen_v5_cut_depth($voxelSize): int {
    [$vx, $vy, $vz] = lumen_v3_usable_voxel($voxelSize);
    $r = 32.0 * max($vx, $vy) / $vz;
    // The nearest power of two in log scale: n with 2^(n − ½) ≤ r < 2^(n + ½) (a tie is
    // irrational, so a double never sits on one); exact powers of two decide the floor.
    $n = (int)floor(log($r) / M_LN2);
    while ($n > -1100 && 2.0 ** $n > $r) $n--;
    while (2.0 ** ($n + 1) <= $r) $n++;
    if ($r >= (2.0 ** $n) * M_SQRT2) $n++;
    return (int)min(32, max(1, 2 ** max(0, min(6, $n))));
}

function lumen_v5_cut_grid(array $dims, int $bz): array {
    return [intdiv($dims['x'] + 31, 32), intdiv($dims['y'] + 31, 32), intdiv($dims['z'] + $bz - 1, $bz)];
}

function lumen_v5_cut_super_grid(array $dims, int $bz): array {
    [$gx, $gy, $gz] = lumen_v5_cut_grid($dims, $bz);
    return [intdiv($gx + 7, 8), intdiv($gy + 7, 8), intdiv($gz + 7, 8)];
}

/** [height, width] of a cut brick's mosaic: bz slices of 32², min(bz, 8) per row. */
function lumen_v5_cut_mosaic_shape(int $bz): array {
    $cols = min($bz, 8);
    return [LUMEN_V5_CUT_XY * intdiv($bz + $cols - 1, $cols), LUMEN_V5_CUT_XY * $cols];
}

function lumen_v5_orth_blocks(int $n): int { return intdiv($n + LUMEN_V5_ORTH_ROWS - 1, LUMEN_V5_ORTH_ROWS); }

function lumen_v5_brick_pack_rel(int $k, string $cid, int $c, int $p): string { return sprintf('l%d/%s/c%d/p%05d.bin', $k, $cid, $c, $p); }
function lumen_v5_index_rel(string $cid): string { return "index/$cid.bin"; }
function lumen_v5_xy_pack_rel(int $k, int $z): string { return sprintf('xy/l%d/z%05d.bin', $k, $z); }
function lumen_v5_orth_pack_rel(string $kind, int $k, int $c, int $b): string { return sprintf('%s/l%d/c%d/b%05d.bin', $kind, $k, $c, $b); }
function lumen_v5_cut_pack_rel(int $k, int $c, int $p): string { return sprintf('cuts/l%d/c%d/p%05d.bin', $k, $c, $p); }
function lumen_v5_cut_index_rel(int $k): string { return "cuts/l$k/index.bin"; }

/** value_of of the bounded quantizer of half-width e (format5.quantizer): 256 entries. */
function lumen_v5_quantizer_values(int $e): array {
    $v = array_fill(0, 256, 0);
    for ($s = 1, $k = 1; $s <= 255; $k++) {
        $hi = min(255, $s + 2 * $e);
        $v[$k] = min($hi, $s + $e);
        $s = $hi + 1;
    }
    return $v;
}

/** 5 or 6 for a matrix-tree schema, else null (format5.schema_format). */
function lumen_v5_schema_format($schema): ?int {
    foreach (LUMEN_V5_FORMAT_SCHEMAS as $fmt => $s) if ($schema === $s) return $fmt;
    return null;
}

/** The column ids of format $fmt, or of a manifest (its schema) (format5.columns_of). */
function lumen_v5_columns_of($fmt): array {
    if (is_array($fmt)) $fmt = lumen_v5_schema_format($fmt['schema'] ?? null);
    if (!is_int($fmt) || !isset(LUMEN_V5_FORMAT_COLUMNS[$fmt])) throw new InvalidArgumentException('no brick format ' . var_export($fmt, true));
    return LUMEN_V5_FORMAT_COLUMNS[$fmt];
}

/** The manifest's `columns` rows of format $fmt (format5.manifest_columns), keys in its order. */
function lumen_v5_manifest_columns(int $fmt = 5): array {
    $rows = [
        'll' => ['id' => 'll', 'codec' => 'webp-lossless', 'mosaic' => 'grid66', 'maxError' => 0],
        'b2' => ['id' => 'b2', 'codec' => 'webp-lossless-lut', 'mosaic' => 'grid66', 'maxError' => 2, 'lut' => lumen_v5_quantizer_values(2)],
        'b4' => ['id' => 'b4', 'codec' => 'webp-lossless-lut', 'mosaic' => 'grid66', 'maxError' => 4, 'lut' => lumen_v5_quantizer_values(4)],
        'q80' => ['id' => 'q80', 'codec' => 'webp-lossy-dz', 'mosaic' => 'grid80', 'quality' => 80, 'maxError' => null],
        'q50' => ['id' => 'q50', 'codec' => 'webp-lossy-dz', 'mosaic' => 'grid80', 'quality' => 50, 'maxError' => null],
        'q30' => ['id' => 'q30', 'codec' => 'webp-lossy-dz', 'mosaic' => 'grid80', 'quality' => 30, 'maxError' => null],
    ];
    return array_map(fn($cid) => $rows[$cid], lumen_v5_columns_of($fmt));
}

function lumen_v5_xyz(array $v): array { return ['x' => $v[0], 'y' => $v[1], 'z' => $v[2]]; }

/** format5.stores_doc. */
function lumen_v5_stores_doc(array $levels): array {
    $cut = [];
    foreach ($levels as $L) {
        $bz = lumen_v5_cut_depth($L['voxelSize']);
        $cut[] = ['level' => $L['level'], 'brickZ' => $bz, 'gridSize' => lumen_v5_xyz(lumen_v5_cut_grid($L['dimensions'], $bz)),
                  'superGrid' => lumen_v5_xyz(lumen_v5_cut_super_grid($L['dimensions'], $bz))];
    }
    return [
        'xy' => ['tileSize' => LUMEN_MIG_TILE, 'codec' => 'png-gray8', 'level0' => 'planes', 'packPattern' => 'xy/l{k}/z{z}.bin'],
        'xz' => ['rowsPerPack' => LUMEN_V5_ORTH_ROWS, 'tileSize' => LUMEN_MIG_TILE, 'codec' => 'png-gray8', 'packPattern' => 'xz/l{k}/c{c}/b{b}.bin'],
        'yz' => ['rowsPerPack' => LUMEN_V5_ORTH_ROWS, 'tileSize' => LUMEN_MIG_TILE, 'codec' => 'png-gray8', 'packPattern' => 'yz/l{k}/c{c}/b{b}.bin'],
        'cuts' => ['brickXY' => LUMEN_V5_CUT_XY, 'superBlock' => LUMEN_V5_CUT_SUPER, 'codec' => 'webp-lossless',
                   'packPattern' => 'cuts/l{k}/c{c}/p{p}.bin', 'levels' => $cut],
    ];
}

/** LBIX of one or more levels: $levels [[gx, gy, gz, packs]], $entries[level][channel] = n·10 bytes. */
function lumen_v5_index_bytes(array $levels, int $channels, array $entries): string {
    $s = lumen_v3_index_head($levels, $channels);
    foreach ($levels as $k => $_L) for ($c = 0; $c < $channels; $c++) $s .= $entries[$k][$c];
    return $s;
}

/** [pack count, total length] of one channel's entries (n·10 bytes): packs = max present pack + 1. */
function lumen_v5_entries_stats(string $e): array {
    $packs = 0; $bytes = 0; $stored = 0;
    for ($i = 0, $n = intdiv(strlen($e), 10); $i < $n; $i++) {
        $r = unpack('vp/Vo/Vl', $e, 10 * $i);
        if (!$r['l']) continue;
        $packs = max($packs, $r['p'] + 1);
        $bytes += $r['l'];
        $stored++;
    }
    return [$packs, $bytes, $stored];
}

/** Packs written group by group under the format-4 rule (format5.PackWriter). */
final class LumenV5PackWriter {
    private $pathOf;
    private int $maxItems;
    private int $maxBytes;
    public int $index = -1;
    private $fh = null;
    private int $count = 0;
    private int $offset = 0;
    public function __construct(callable $pathOf, int $maxItems = LUMEN_V3_PACK_MAX_BRICKS, int $maxBytes = LUMEN_V3_PACK_MAX_BYTES) {
        $this->pathOf = $pathOf; $this->maxItems = $maxItems; $this->maxBytes = $maxBytes;
    }
    private function openNext(): void {
        if ($this->fh !== null) fclose($this->fh);
        $this->index++;
        $path = ($this->pathOf)($this->index);
        $dir = dirname($path);
        if (!is_dir($dir) && !admin_make_dir($dir)) throw new LumenMigError('assembly_write_failed', 500, $dir);
        $fh = @fopen($path, 'wb');
        if ($fh === false) throw new LumenMigError('assembly_write_failed', 500, $path);
        $this->fh = $fh;
        $this->count = 0; $this->offset = 0;
    }
    /** [[pack, offset, length]] of one group's payloads (none empty). */
    public function addGroup(array $datas): array {
        if (!$datas) return [];
        $n = count($datas); $b = 0;
        foreach ($datas as $d) $b += strlen($d);
        if ($this->fh === null || ($this->count && ($this->count + $n > $this->maxItems || $this->offset + $b > $this->maxBytes))) $this->openNext();
        $split = $n > $this->maxItems || $b > $this->maxBytes;
        $out = [];
        foreach ($datas as $d) {
            if ($split && $this->count && ($this->count >= $this->maxItems || $this->offset + strlen($d) > $this->maxBytes)) $this->openNext();
            $out[] = [$this->index, $this->offset, strlen($d)];
            if (@fwrite($this->fh, $d) !== strlen($d)) throw new LumenMigError('assembly_write_failed', 500, 'short write');
            $this->offset += strlen($d);
            $this->count++;
        }
        return $out;
    }
    public function close(): void {
        if ($this->fh !== null) { fclose($this->fh); $this->fh = null; }
    }
}

// ── Reading a v5 tree (format5.tree_problem, dataset_migrations._build_v5_trees) ─

function lumen_v5_tree_rels(array $man): array {
    $tps = $man['timepoints'] ?? null;
    if (is_array($tps) && $tps && array_keys($tps) === range(0, count($tps) - 1)) {
        $out = [];
        foreach ($tps as $row) if (is_array($row)) $out[] = $row['path'] ?? null;
        return $out;
    }
    return [''];
}

function lumen_v5_tree_index_info(array $man, string $rel): array {
    if ($rel === '') return is_array($man['index'] ?? null) ? $man['index'] : [];
    foreach ($man['timepoints'] ?? [] as $row) {
        if (is_array($row) && ($row['path'] ?? null) === $rel) return is_array($row['index'] ?? null) ? $row['index'] : [];
    }
    return [];
}

/** Max end per pack of one channel's entries ($data from $at, n entries): [pack => end]. */
function lumen_v5_pack_ends(string $data, int $at, int $n): array {
    $ends = [];
    for ($i = 0; $i < $n; $i++) {
        $e = unpack('vp/Vo/Vl', $data, $at + 10 * $i);
        if (!$e['l']) continue;
        $end = $e['o'] + $e['l'];
        if (!isset($ends[$e['p']]) || $ends[$e['p']] < $end) $ends[$e['p']] = $end;
    }
    return $ends;
}

/**
 * The first structural fault of one tree of a v5 manifest, or null (format5.tree_problem):
 * every column and cut index present with the size and sha256 the manifest records, every
 * pack they reference long enough, every xy plane pack (levels ≥ 1) and xz / yz pack present.
 */
function lumen_v5_tree_problem(string $bricksDir, array $man, string $rel, bool $planes = true): ?string {
    $base = $rel === '' ? $bricksDir : "$bricksDir/$rel";
    $info = lumen_v5_tree_index_info($man, $rel);
    $levels = $man['levels'] ?? null;
    $C = $man['channels'] ?? null;
    if (!$info || !is_array($levels) || !$levels || !is_int($C)) return 'manifest: no index';
    $prefix = $rel === '' ? '' : "$rel/";
    try {
        $grids = [];
        foreach ($levels as $L) $grids[] = [(int)$L['gridSize']['x'], (int)$L['gridSize']['y'], (int)$L['gridSize']['z']];
        $readRef = function ($ref, string $relExpected) use ($base, $prefix): array {
            if (!is_array($ref) || ($ref['url'] ?? null) !== $prefix . $relExpected) throw new InvalidArgumentException("$relExpected: not in the manifest");
            $path = "$base/$relExpected";
            clearstatcache(true, $path);
            $blob = is_file($path) ? @file_get_contents($path) : false;
            if (!is_string($blob)) throw new InvalidArgumentException("$relExpected missing");
            if (strlen($blob) !== ($ref['bytes'] ?? null) || hash('sha256', $blob) !== ($ref['sha256'] ?? null)) throw new InvalidArgumentException("$relExpected differs from the manifest");
            return [$blob, lumen_v3_parse_index($blob)];
        };
        $checkPacks = function (string $blob, array $idx, int $lv, callable $relOf) use ($base, $C): void {
            [$gx, $gy, $gz] = $idx['levels'][$lv];
            $n = $gx * $gy * $gz;
            for ($c = 0; $c < $C; $c++) {
                foreach (lumen_v5_pack_ends($blob, $idx['entriesAt'][$lv] + $c * $n * 10, $n) as $pk => $end) {
                    $p = "$base/" . $relOf($c, $pk);
                    clearstatcache(true, $p);
                    if (!is_file($p)) throw new InvalidArgumentException($relOf($c, $pk) . ' missing');
                    if ((int)filesize($p) < $end) throw new InvalidArgumentException($relOf($c, $pk) . ' shorter than its bricks');
                }
            }
        };
        $ids = lumen_v5_columns_of($man);
        $cols = is_array($info['columns'] ?? null) ? $info['columns'] : [];
        $have = array_map('strval', array_keys($cols));
        $want = $ids;
        sort($have, SORT_STRING); sort($want, SORT_STRING);
        if ($have !== $want) throw new InvalidArgumentException("index columns differ from the format's");
        $mcols = [];
        foreach (is_array($man['columns'] ?? null) ? $man['columns'] : [] as $row) if (is_array($row)) $mcols[] = $row['id'] ?? null;
        if ($mcols !== $ids) throw new InvalidArgumentException("manifest columns differ from the format's");
        foreach ($ids as $cid) {
            [$blob, $idx] = $readRef($cols[$cid] ?? null, lumen_v5_index_rel($cid));
            if ($idx['channels'] !== $C || array_map(fn($l) => array_slice($l, 0, 3), $idx['levels']) !== $grids) throw new InvalidArgumentException("index/$cid.bin grids differ from the manifest");
            foreach ($idx['levels'] as $k => $_l) $checkPacks($blob, $idx, $k, fn($c, $pk) => lumen_v5_brick_pack_rel($k, $cid, $c, $pk));
        }
        $cuts = is_array($info['cuts'] ?? null) ? $info['cuts'] : [];
        if (count($cuts) !== count($levels)) throw new InvalidArgumentException('cut indexes: one per level expected');
        foreach ($levels as $k => $L) {
            [$blob, $idx] = $readRef($cuts[$k] ?? null, lumen_v5_cut_index_rel($k));
            $bz = lumen_v5_cut_depth($L['voxelSize']);
            if ($idx['channels'] !== $C || array_map(fn($l) => array_slice($l, 0, 3), $idx['levels']) !== [lumen_v5_cut_super_grid($L['dimensions'], $bz)]) {
                throw new InvalidArgumentException(lumen_v5_cut_index_rel($k) . ' grid differs');
            }
            $checkPacks($blob, $idx, 0, fn($c, $pk) => lumen_v5_cut_pack_rel($k, $c, $pk));
        }
        if ($planes) {
            foreach ($levels as $k => $L) {
                $d = $L['dimensions'];
                if ($k) {
                    for ($z = 0; $z < $d['z']; $z++) if (!is_file("$base/" . lumen_v5_xy_pack_rel($k, $z))) throw new InvalidArgumentException(lumen_v5_xy_pack_rel($k, $z) . ' missing');
                }
                foreach (['xz' => $d['y'], 'yz' => $d['x']] as $kind => $n) {
                    for ($c = 0; $c < $C; $c++) for ($b = 0, $nb = lumen_v5_orth_blocks((int)$n); $b < $nb; $b++) {
                        if (!is_file("$base/" . lumen_v5_orth_pack_rel($kind, $k, $c, $b))) throw new InvalidArgumentException(lumen_v5_orth_pack_rel($kind, $k, $c, $b) . ' missing');
                    }
                }
            }
        }
    } catch (InvalidArgumentException | TypeError $e) {
        return ($rel === '' ? 'bricks' : $rel) . ': ' . $e->getMessage();
    }
    return null;
}

/**
 * Trees of a format-5 manifest (dataset_migrations._build_v5_trees): `index` = the level-0
 * entries of index/ll.bin (the native lossless bricks, v3 mosaics) so m002 / m003 repairs
 * read them. [trees, problem].
 */
function lumen_v5_build_trees(string $type, string $bricksRoot, array $man): array {
    $levels = $man['levels'] ?? null;
    $C = $man['channels'] ?? null;
    if (!is_array($levels) || !$levels || !is_array($levels[0] ?? null)) throw new InvalidArgumentException('levels');
    if (!is_int($C) || $C < 1 || $C > 64) throw new InvalidArgumentException('channels');
    $d0 = is_array($levels[0]['dimensions'] ?? null) ? $levels[0]['dimensions'] : [];
    [$X, $Y, $Z] = [lumen_mig_int_dim($d0['x'] ?? null), lumen_mig_int_dim($d0['y'] ?? null), lumen_mig_int_dim($d0['z'] ?? null)];
    $trees = []; $problem = null; $seen = [];
    foreach (lumen_v5_tree_rels($man) as $i => $rel) {
        $rel = is_string($rel) ? $rel : '';
        if ($rel !== '' && !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/D', $rel)) throw new InvalidArgumentException("timepoint path $rel");
        if ($type !== 'live' && $rel !== '') throw new InvalidArgumentException('timepoints on a non-live dataset');
        $t = $rel === '' ? 0 : (preg_match('/^t(\d{1,6})$/D', $rel, $mm) ? (int)$mm[1] : $i);
        if (isset($seen[$t])) throw new InvalidArgumentException("timepoint $rel twice");
        $seen[$t] = true;
        $dir = $rel === '' ? $bricksRoot : "$bricksRoot/$rel";
        $tree = ['t' => $t, 'rel' => $rel, 'bricksDir' => $dir, 'X' => $X, 'Y' => $Y, 'Z' => $Z, 'C' => $C,
                 'nx' => intdiv($X + 63, 64), 'ny' => intdiv($Y + 63, 64), 'nz' => intdiv($Z + 63, 64),
                 'TX' => intdiv($X + 511, 512), 'TY' => intdiv($Y + 511, 512),
                 'encoding' => 'v3', 'cols' => LUMEN_V3_COLS, 'index' => []];
        $p = lumen_v5_tree_problem($bricksRoot, $man, $rel);
        if ($p !== null) {
            $problem = $problem ?? $p;
        } else {
            $blob = (string)file_get_contents("$dir/" . lumen_v5_index_rel('ll'));
            $idx = lumen_v3_parse_index($blob);
            [$gx, $gy, $gz] = $idx['levels'][0];
            $n = $gx * $gy * $gz;
            for ($c = 0; $c < $C; $c++) {
                $at = $idx['entriesAt'][0] + $c * $n * 10;
                for ($i2 = 0; $i2 < $n; $i2++) {
                    $e = unpack('vp/Vo/Vl', $blob, $at + 10 * $i2);
                    if (!$e['l']) continue;
                    $bx = $i2 % $gx; $r = intdiv($i2, $gx); $by = $r % $gy; $bz = intdiv($r, $gy);
                    $tree['index']["$c:$bx:$by:$bz"] = ["$dir/" . lumen_v5_brick_pack_rel(0, 'll', $c, $e['p']), $e['o'], $e['l']];
                }
            }
        }
        $trees[] = $tree;
    }
    return [$trees, $problem];
}

// ── m005 units ───────────────────────────────────────────────────────────────

function lumen_m005_key(array $u): string {
    [$s, $t, $k, $c, $a, $b, $d] = $u;
    if ($s === 0) return "A.t$t.c$c.z$a";
    if ($s === 1) return "B.t$t.k$k.c$c.z$a.y$b.x$d";
    if ($s === 2) return "C.t$t.k$k.c$c." . LUMEN_M005_ORTH[$a] . ".b$b";
    return "D.t$t.k$k.c$c.z$a.y$b.x$d";
}

function lumen_m005_parse($key): array {
    $key = is_string($key) ? $key : '';
    $rx = [
        'A' => '/^A\.t(\d{1,6})\.c(\d{1,3})\.z(\d{1,5})$/D',
        'B' => '/^B\.t(\d{1,6})\.k(\d{1,2})\.c(\d{1,3})\.z(\d{1,5})\.y(\d{1,5})\.x(\d{1,5})$/D',
        'C' => '/^C\.t(\d{1,6})\.k(\d{1,2})\.c(\d{1,3})\.(xz|yz)\.b(\d{1,5})$/D',
        'D' => '/^D\.t(\d{1,6})\.k(\d{1,2})\.c(\d{1,3})\.z(\d{1,5})\.y(\d{1,5})\.x(\d{1,5})$/D',
    ][$key[0] ?? ''] ?? null;
    if ($rx === null || !preg_match($rx, $key, $m)) throw new LumenMigError('bad_unit');
    $g = array_slice($m, 1);
    if ($key[0] === 'A') return [0, (int)$g[0], 0, (int)$g[1], (int)$g[2], 0, 0];
    if ($key[0] === 'C') return [2, (int)$g[0], (int)$g[1], (int)$g[2], array_search($g[3], LUMEN_M005_ORTH, true), (int)$g[4], 0];
    return [strpos(LUMEN_M005_STAGES, $key[0]), (int)$g[0], (int)$g[1], (int)$g[2], (int)$g[3], (int)$g[4], (int)$g[5]];
}

/** The columns a level's brick units make: every one but the level-0 `ll` (the format-4 bricks). */
function lumen_m005_columns(int $k): array {
    return $k ? LUMEN_V5_COLUMN_IDS : array_values(array_filter(LUMEN_V5_COLUMN_IDS, fn($c) => $c !== 'll'));
}

/** Summed-area table of a brick grid [gx, gy, gz] from $cells [flat (bz·gy + by)·gx + bx => value]. */
function lumen_m005_sat(array $grid, array $cells): array {
    [$gx, $gy, $gz] = $grid;
    $sx = $gx + 1; $sy = $gy + 1;
    $a = array_fill(0, $sx * $sy * ($gz + 1), 0);
    foreach ($cells as $i => $v) {
        $bx = $i % $gx; $r = intdiv($i, $gx); $by = $r % $gy; $bz = intdiv($r, $gy);
        $a[(($bz + 1) * $sy + $by + 1) * $sx + $bx + 1] += $v;
    }
    for ($z = 1; $z <= $gz; $z++) for ($y = 0; $y <= $gy; $y++) for ($x = 0; $x <= $gx; $x++) $a[($z * $sy + $y) * $sx + $x] += $a[(($z - 1) * $sy + $y) * $sx + $x];
    for ($z = 0; $z <= $gz; $z++) for ($y = 1; $y <= $gy; $y++) for ($x = 0; $x <= $gx; $x++) $a[($z * $sy + $y) * $sx + $x] += $a[($z * $sy + $y - 1) * $sx + $x];
    for ($z = 0; $z <= $gz; $z++) for ($y = 0; $y <= $gy; $y++) for ($x = 1; $x <= $gx; $x++) $a[($z * $sy + $y) * $sx + $x] += $a[($z * $sy + $y) * $sx + $x - 1];
    return ['a' => $a, 'g' => $grid];
}

/** Sum of the cells [z0, z1) × [y0, y1) × [x0, x1), clipped. */
function lumen_m005_sat_box(array $s, int $z0, int $z1, int $y0, int $y1, int $x0, int $x1): int {
    [$gx, $gy, $gz] = $s['g'];
    $z0 = max(0, $z0); $z1 = min($gz, $z1); $y0 = max(0, $y0); $y1 = min($gy, $y1); $x0 = max(0, $x0); $x1 = min($gx, $x1);
    if ($z0 >= $z1 || $y0 >= $y1 || $x0 >= $x1) return 0;
    $sx = $gx + 1; $sy = $gy + 1; $a = $s['a'];
    $at = fn($z, $y, $x) => $a[($z * $sy + $y) * $sx + $x];
    return $at($z1, $y1, $x1) - $at($z0, $y1, $x1) - $at($z1, $y0, $x1) - $at($z1, $y1, $x0)
         + $at($z0, $y0, $x1) + $at($z0, $y1, $x0) + $at($z1, $y0, $x0) - $at($z0, $y0, $x0);
}

/** Level-0 brick ranges [[z0, z1], [y0, y1], [x0, x1]] under a level-k voxel range. */
function lumen_m005_footprint(array $dims0, array $dimsk, array $xr, array $yr, array $zr): array {
    [$X0, $Y0] = $dims0; [$Xk, $Yk] = $dimsk;
    $vx0 = intdiv($xr[0] * $X0, $Xk); $vx1 = intdiv($xr[1] * $X0 + $Xk - 1, $Xk);
    $vy0 = intdiv($yr[0] * $Y0, $Yk); $vy1 = intdiv($yr[1] * $Y0 + $Yk - 1, $Yk);
    return [[intdiv($zr[0], 64), intdiv($zr[1] + 63, 64)], [intdiv($vy0, 64), intdiv($vy1 + 63, 64)], [intdiv($vx0, 64), intdiv($vx1 + 63, 64)]];
}

/**
 * Every unit of m005 (dataset_migrations._m005_unitset): a unit is empty when no format-4
 * level-0 brick of its channel lies under it; its bytes are the level-0 bytes under it scaled
 * to the level (A: the plane's exact bytes).
 */
function lumen_m005_unitset(array $plan): array {
    if (!empty($plan['v5'])) throw new LumenMigError('already_v5', 409);
    if (empty($plan['v3'])) throw new LumenMigError('needs_format4', 409);
    if ($plan['v3Problem'] !== null) throw new LumenMigError('bricks_v3_invalid', 409, $plan['v3Problem']);
    if (!lumen_mig_planes_valid($plan)) throw new LumenMigError('planes_missing', 409);
    lumen_mig_m004_levels($plan);       // every frame of a timelapse has the same dimensions
    $ts = array_keys($plan['trees']);
    sort($ts);
    $first = $plan['trees'][$ts[0]];
    [$X0, $Y0, $Z0] = [$first['X'], $first['Y'], $first['Z']];
    $levels = lumen_v5_ladder($X0, $Y0, $Z0, $plan['voxel']);
    $rows = []; $unitBytes = []; $total = 0; $inputs = [];
    $span = 64 * LUMEN_V5_SUPER;
    foreach ($ts as $t) {
        $tree = $plan['trees'][$t];
        $d = lumen_mig_tree_planes_dir($plan['dir'], $tree);
        $inputs[(string)$t] = hash_file('sha256', "$d/manifest.json");
        $C = $tree['C'];
        $perC = $tree['TY'] * $tree['TX'];
        $planeBytes = [];
        if (count($levels) > 1) {
            for ($z = 0; $z < $Z0; $z++) {
                $name = sprintf('z%05d.bin', $z);
                $fh = @fopen("$d/$name", 'rb');
                if ($fh === false) throw new LumenMigError('planes_invalid', 409, "$name: unreadable");
                try {
                    $entries = lumen_mig_pack_entries($fh, LUMEN_MIG_PACK_MAGIC, $C, $tree['TX'], $tree['TY'], $z);
                } catch (InvalidArgumentException $e) {
                    throw new LumenMigError('planes_invalid', 409, "$name: " . $e->getMessage());
                } finally {
                    fclose($fh);
                }
                for ($c = 0; $c < $C; $c++) {
                    $n = 0;
                    for ($i = $c * $perC; $i < ($c + 1) * $perC; $i++) $n += $entries[$i][1];
                    $planeBytes[$c][$z] = $n;
                }
            }
        }
        $g0 = [$tree['nx'], $tree['ny'], $tree['nz']];
        $cellsN = []; $cellsB = [];
        foreach ($tree['index'] as $ck => $ref) {
            [$cc, $bx, $by, $bz] = array_map('intval', explode(':', $ck));
            $i = ($bz * $g0[1] + $by) * $g0[0] + $bx;
            $cellsN[$cc][$i] = 1;
            $cellsB[$cc][$i] = $ref[2];
        }
        for ($c = 0; $c < $C; $c++) {
            $sn = lumen_m005_sat($g0, $cellsN[$c] ?? []);
            $sb = lumen_m005_sat($g0, $cellsB[$c] ?? []);
            if (count($levels) > 1) {
                for ($z = 0; $z < $Z0; $z++) {
                    $total++;
                    $n = $planeBytes[$c][$z] ?? 0;
                    if ($n) { $u = [0, $t, 0, $c, $z, 0, 0]; $rows[] = $u; $unitBytes[lumen_m005_key($u)] = $n; }
                }
            }
            foreach ($levels as $L) {
                $k = $L['level'];
                [$Xk, $Yk, $Zk] = [$L['dimensions']['x'], $L['dimensions']['y'], $L['dimensions']['z']];
                $scale = ($Xk * $Yk) / (float)($X0 * $Y0);
                $add = function (array $u, array $xr, array $yr, array $zr) use (&$total, &$rows, &$unitBytes, $X0, $Y0, $Xk, $Yk, $sn, $sb, $scale): void {
                    $total++;
                    [[$bz0, $bz1], [$by0, $by1], [$bx0, $bx1]] = lumen_m005_footprint([$X0, $Y0], [$Xk, $Yk], $xr, $yr, $zr);
                    if (lumen_m005_sat_box($sn, $bz0, $bz1, $by0, $by1, $bx0, $bx1)) {
                        $rows[] = $u;
                        $unitBytes[lumen_m005_key($u)] = max(1, (int)(lumen_m005_sat_box($sb, $bz0, $bz1, $by0, $by1, $bx0, $bx1) * $scale));
                    }
                };
                [$gx, $gy, $gz] = [$L['gridSize']['x'], $L['gridSize']['y'], $L['gridSize']['z']];
                for ($BZ = 0; $BZ < intdiv($gz + 3, 4); $BZ++) for ($BY = 0; $BY < intdiv($gy + 3, 4); $BY++) for ($BX = 0; $BX < intdiv($gx + 3, 4); $BX++) {
                    $add([1, $t, $k, $c, $BZ, $BY, $BX],
                         [max(0, $span * $BX - 1), min($Xk, $span * $BX + $span + 1)],
                         [max(0, $span * $BY - 1), min($Yk, $span * $BY + $span + 1)],
                         [max(0, $span * $BZ - 1), min($Zk, $span * $BZ + $span + 1)]);
                }
                foreach ([[0, $Yk], [1, $Xk]] as [$kind, $n]) {
                    for ($b = 0, $nb = lumen_v5_orth_blocks($n); $b < $nb; $b++) {
                        $r = [$b * LUMEN_V5_ORTH_ROWS, min($n, $b * LUMEN_V5_ORTH_ROWS + LUMEN_V5_ORTH_ROWS)];
                        if ($kind === 0) $add([2, $t, $k, $c, 0, $b, 0], [0, $Xk], $r, [0, $Zk]);
                        else $add([2, $t, $k, $c, 1, $b, 0], $r, [0, $Yk], [0, $Zk]);
                    }
                }
                $bzd = lumen_v5_cut_depth($L['voxelSize']);
                [$sgx, $sgy, $sgz] = lumen_v5_cut_super_grid($L['dimensions'], $bzd);
                $sxy = LUMEN_V5_CUT_XY * LUMEN_V5_CUT_SUPER; $szz = $bzd * LUMEN_V5_CUT_SUPER;
                for ($SZ = 0; $SZ < $sgz; $SZ++) for ($SY = 0; $SY < $sgy; $SY++) for ($SX = 0; $SX < $sgx; $SX++) {
                    $add([3, $t, $k, $c, $SZ, $SY, $SX], [$sxy * $SX, min($Xk, $sxy * $SX + $sxy)],
                         [$sxy * $SY, min($Yk, $sxy * $SY + $sxy)], [$szz * $SZ, min($Zk, $szz * $SZ + $szz)]);
                }
            }
        }
    }
    usort($rows, fn($a, $b) => [$a[0] === 0 ? 0 : 1, $a[2], $a[1], $a[0], $a[3], $a[4], $a[5], $a[6]]
                            <=> [$b[0] === 0 ? 0 : 1, $b[2], $b[1], $b[0], $b[3], $b[4], $b[5], $b[6]]);
    $units = [];
    foreach ($rows as $u) $units[lumen_m005_key($u)] = $u;
    return ['mid' => LUMEN_M005, 'units' => $units, 'unitBytes' => $unitBytes, 'total' => $total,
            'empty' => $total - count($units), 'inputs' => $inputs, 'refs' => null, 'levels' => $levels];
}

/** Level-0 units and stage A run at once; a level-k ≥ 1 unit of B, C or D waits for stage A of its tree and channel. */
function lumen_m005_runnable(array $pending): array {
    $aLeft = [];
    foreach ($pending as $u) if ($u[0] === 0) $aLeft[$u[1] . ':' . $u[3]] = true;
    $run = [];
    foreach ($pending as $k => $u) if ($u[0] === 0 || $u[2] === 0 || !isset($aLeft[$u[1] . ':' . $u[3]])) $run[$k] = $u;
    return $run;
}

function lumen_m005_stage_ready(array $us, array $done, array $unit): bool {
    if (!$unit[0] || !$unit[2]) return true;
    foreach ($us['units'] as $k => $u) if ($u[0] === 0 && $u[1] === $unit[1] && $u[3] === $unit[3] && !isset($done[$k])) return false;
    return true;
}

function lumen_m005_stage_progress(array $us, array $done): array {
    $rows = [];
    for ($s = 0; $s < 4; $s++) {
        $n = 0; $d = 0;
        foreach ($us['units'] as $k => $u) if ($u[0] === $s) { $n++; if (isset($done[$k])) $d++; }
        $rows[] = ['stage' => LUMEN_M005_STAGES[$s], 'units' => $n, 'done' => $d];
    }
    return $rows;
}

function lumen_m005_store_a(string $store, int $t, int $k, int $c, int $z): string {
    return "$store/A/t$t/k$k/c$c/z$z.bin";
}

function lumen_m005_store_path(string $store, array $u): string {
    [$s, $t, $k, $c, $a, $b, $d] = $u;
    $base = "$store/" . LUMEN_M005_STAGES[$s] . "/t$t/k$k/c$c";
    if ($s === 2) return "$base/" . LUMEN_M005_ORTH[$a] . "/b$b.bin";
    return "$base/z$a.y$b.x$d.bin";
}

// ── m005, browser executor: inputs, uploads ──────────────────────────────────

/** Non-empty png-gray8 tiles of level-k plane z of channel c meeting the box (dataset_migrations._m005_plane_tiles). */
function lumen_m005_plane_tiles(array $plan, string $store, int $t, int $k, int $c, int $z, int $y0, int $y1, int $x0, int $x1, array $levels): array {
    $X = $levels[$k]['dimensions']['x']; $Y = $levels[$k]['dimensions']['y'];
    $txn = intdiv($X + 511, 512); $tyn = intdiv($Y + 511, 512);
    $tree = $plan['trees'][$t];
    if ($k === 0) {
        $name = sprintf('z%05d.bin', $z);
        $path = lumen_mig_tree_planes_dir($plan['dir'], $tree) . "/$name";
        $rel = ($tree['rel'] === '' ? 'planes' : "planes/{$tree['rel']}") . "/$name";
        $C = $tree['C']; $ci = $c;
    } else {
        $path = lumen_m005_store_a($store, $t, $k, $c, $z);
        $rel = "@store/A/t$t/k$k/c$c/z$z.bin";
        $C = 1; $ci = 0;
    }
    $fh = @fopen($path, 'rb');
    if ($fh === false) {
        if ($k === 0) throw new LumenMigError('plane_unreadable', 500, sprintf('z%05d.bin', $z));
        return [];
    }
    try {
        $entries = lumen_mig_pack_entries($fh, LUMEN_MIG_PACK_MAGIC, $C, $txn, $tyn, $z);
    } catch (InvalidArgumentException $e) {
        throw new LumenMigError('plane_unreadable', 500, "$rel: " . $e->getMessage());
    } finally {
        fclose($fh);
    }
    $out = [];
    for ($ty = intdiv($y0, 512); $ty < intdiv($y1 + 511, 512); $ty++) {
        for ($tx = intdiv($x0, 512); $tx < intdiv($x1 + 511, 512); $tx++) {
            [$off, $ln] = $entries[($ci * $tyn + $ty) * $txn + $tx];
            if ($ln) $out[] = ['rel' => $rel, 'start' => $off, 'end' => $off + $ln, 'z' => $z, 'x0' => $tx * 512, 'y0' => $ty * 512,
                               'w' => min(512, $X - $tx * 512), 'h' => min(512, $Y - $ty * 512)];
        }
    }
    return $out;
}

/** What a browser m005 unit reads and makes (dataset_migrations._unit_inputs_m005). */
function lumen_m005_unit_inputs(array $plan, string $path, $key): array {
    $us = lumen_mig_unitset($plan, LUMEN_M005);
    $unit = lumen_m005_parse($key);
    [$s, $t, $k, $c, $a, $b, $d] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $c >= $tree['C'] || $k >= count($us['levels'])) throw new LumenMigError('bad_unit');
    $ukey = lumen_m005_key($unit);
    if (!isset($us['unitBytes'][$ukey])) return ['ok' => true, 'migration' => LUMEN_M005, 'unit' => $ukey, 'empty' => true];
    $j = lumen_mig_load_journal($path) ?? [];
    if (!lumen_m005_stage_ready($us, array_flip($j['done'] ?? []), $unit)) throw new LumenMigError('unit_blocked', 409, 'stage A of this tree/channel is not complete');
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], LUMEN_M005);
    $L = $us['levels'][$k];
    [$X, $Y, $Z] = [$L['dimensions']['x'], $L['dimensions']['y'], $L['dimensions']['z']];
    $levels = [];
    foreach ($us['levels'] as $x) $levels[] = ['level' => $x['level'], 'target' => $x['target'], 'dimensions' => $x['dimensions'], 'voxelSize' => $x['voxelSize']];
    $out = ['ok' => true, 'migration' => LUMEN_M005, 'unit' => $ukey, 'empty' => false,
            'stage' => LUMEN_M005_STAGES[$s], 'tree' => $tree['rel'], 't' => $t, 'level' => $k, 'channel' => $c,
            'levels' => $levels, 'columns' => lumen_m005_columns($k)];
    $tiles = []; $bricks = [];
    $planes = function (int $z0, int $z1, int $y0, int $y1, int $x0, int $x1) use (&$tiles, $plan, $store, $t, $k, $c, $us): void {
        for ($z = $z0; $z < $z1; $z++) foreach (lumen_m005_plane_tiles($plan, $store, $t, $k, $c, $z, $y0, $y1, $x0, $x1, $us['levels']) as $tile) $tiles[] = $tile;
    };
    if ($s === 0) {
        $out['box'] = ['x' => [0, $tree['X']], 'y' => [0, $tree['Y']], 'z' => [$a, $a + 1]];
        $planes($a, $a + 1, 0, $tree['Y'], 0, $tree['X']);
    } elseif ($s === 1) {
        [$gx, $gy, $gz] = [$L['gridSize']['x'], $L['gridSize']['y'], $L['gridSize']['z']];
        $ob = [];
        for ($bz = 4 * $a; $bz < min($gz, 4 * $a + 4); $bz++) for ($by = 4 * $b; $by < min($gy, 4 * $b + 4); $by++) for ($bx = 4 * $d; $bx < min($gx, 4 * $d + 4); $bx++) $ob[] = [$bz, $by, $bx];
        $out['outBricks'] = $ob;
        if ($k === 0) {
            $dsLen = strlen($plan['dir']);
            foreach ($ob as [$bz, $by, $bx]) {
                $ref = $tree['index']["$c:$bx:$by:$bz"] ?? null;
                if ($ref !== null) $bricks[] = ['rel' => ltrim(str_replace('\\', '/', substr($ref[0], $dsLen)), '/'), 'start' => $ref[1],
                                                'end' => $ref[1] + $ref[2], 'bz' => $bz, 'by' => $by, 'bx' => $bx];
            }
        } else {
            $span = 256;
            [$x0, $x1] = [max(0, $span * $d - 1), min($X, $span * $d + $span + 1)];
            [$y0, $y1] = [max(0, $span * $b - 1), min($Y, $span * $b + $span + 1)];
            [$z0, $z1] = [max(0, $span * $a - 1), min($Z, $span * $a + $span + 1)];
            $out['box'] = ['x' => [$x0, $x1], 'y' => [$y0, $y1], 'z' => [$z0, $z1]];
            $planes($z0, $z1, $y0, $y1, $x0, $x1);
        }
    } elseif ($s === 2) {
        $n = $a === 0 ? $Y : $X;
        $first = $b * LUMEN_V5_ORTH_ROWS; $last = min($n, $first + LUMEN_V5_ORTH_ROWS);
        $out += ['kind' => LUMEN_M005_ORTH[$a], 'first' => $first, 'count' => $last - $first];
        $out['box'] = $a === 0 ? ['x' => [0, $X], 'y' => [$first, $last], 'z' => [0, $Z]] : ['x' => [$first, $last], 'y' => [0, $Y], 'z' => [0, $Z]];
        $planes(0, $Z, $out['box']['y'][0], $out['box']['y'][1], $out['box']['x'][0], $out['box']['x'][1]);
    } else {
        $bzd = lumen_v5_cut_depth($L['voxelSize']);
        $sxy = LUMEN_V5_CUT_XY * LUMEN_V5_CUT_SUPER; $szz = $bzd * LUMEN_V5_CUT_SUPER;
        $out += ['brickZ' => $bzd, 'super' => [$a, $b, $d]];
        $out['box'] = ['x' => [$sxy * $d, min($X, $sxy * $d + $sxy)], 'y' => [$sxy * $b, min($Y, $sxy * $b + $sxy)], 'z' => [$szz * $a, min($Z, $szz * $a + $szz)]];
        $planes($out['box']['z'][0], $out['box']['z'][1], $out['box']['y'][0], $out['box']['y'][1], $out['box']['x'][0], $out['box']['x'][1]);
    }
    $out['tiles'] = $tiles;
    $out['bricks'] = $bricks;
    return $out;
}

/** [width, height, lossless] of a still WebP (VP8 or VP8L); InvalidArgumentException otherwise. */
function lumen_v5_webp_size(string $data): array {
    $n = strlen($data);
    if ($n < 20 || substr($data, 0, 4) !== 'RIFF' || substr($data, 8, 4) !== 'WEBP' || unpack('V', $data, 4)[1] + 8 !== $n) throw new InvalidArgumentException('not a WebP');
    for ($pos = 12; $pos < $n;) {
        if ($pos + 8 > $n) throw new InvalidArgumentException('truncated chunk');
        $kind = substr($data, $pos, 4);
        $size = unpack('V', $data, $pos + 4)[1];
        $at = $pos + 8;
        if ($at + $size > $n) throw new InvalidArgumentException('chunk overruns the file');
        if ($kind === 'VP8L') {
            if ($size < 5 || ord($data[$at]) !== 0x2F) throw new InvalidArgumentException('bad VP8L signature');
            $bits = unpack('V', $data, $at + 1)[1];
            return [($bits & 0x3FFF) + 1, (($bits >> 14) & 0x3FFF) + 1, true];
        }
        if ($kind === 'VP8 ') {
            if ($size < 10 || substr($data, $at + 3, 3) !== "\x9d\x01\x2a") throw new InvalidArgumentException('bad VP8 frame');
            $wh = unpack('vw/vh', $data, $at + 6);
            return [$wh['w'] & 0x3FFF, $wh['h'] & 0x3FFF, false];
        }
        if ($kind === 'ANIM' || $kind === 'ANMF') throw new InvalidArgumentException('animated WebP');
        $pos = $at + $size + ($size & 1);
    }
    throw new InvalidArgumentException('no image chunk');
}

/** A column's stored image has the shape SPEC §14.3 gives it (dataset_migrations._m005_check_brick). */
function lumen_m005_check_brick(string $data, string $cid): void {
    if ($cid === 'q80' || $cid === 'q50') {
        if (strlen($data) < 2) throw new InvalidArgumentException('no trailer byte');
        $tag = ord($data[strlen($data) - 1]);
        [$w, $h, $lossless] = lumen_v5_webp_size(substr($data, 0, -1));
        if ($tag === LUMEN_V5_TAG_B4 || $tag === LUMEN_V5_TAG_LL) {
            if ([$w, $h, $lossless] !== [LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H, true]) throw new InvalidArgumentException("fallback image {$w}x{$h}");
        } elseif ($tag <= LUMEN_V5_DEAD_ZONE_MAX) {
            if ([$w, $h] !== [LUMEN_V5_MOSAIC80_W, LUMEN_V5_MOSAIC80_H]) throw new InvalidArgumentException("lossy image {$w}x{$h}");
        } else {
            throw new InvalidArgumentException("trailer byte $tag");
        }
        return;
    }
    [$w, $h, $lossless] = lumen_v5_webp_size($data);
    if ([$w, $h, $lossless] !== [LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H, true]) throw new InvalidArgumentException("image {$w}x{$h}" . ($lossless ? '' : ' lossy'));
}

/** {"bz.by.bx" => {cid => bytes}} of a stage-B blob (dataset_migrations._m005_parse_brick_blob). */
function lumen_m005_parse_brick_blob(string $data, array $columns): array {
    if (strlen($data) < 4) throw new InvalidArgumentException('short');
    $n = unpack('V', $data, 0)[1];
    $pos = 4;
    if (strlen($data) < 4 + 12 * $n + 4 * $n * count($columns)) throw new InvalidArgumentException('truncated');
    $keys = [];
    for ($i = 0; $i < $n; $i++) { $keys[] = array_values(unpack('V3', $data, $pos)); $pos += 12; }
    $lens = [];
    foreach ($columns as $cid) { $lens[$cid] = $n ? array_values(unpack("V$n", $data, $pos)) : []; $pos += 4 * $n; }
    $out = [];
    foreach ($keys as $kk) $out[implode('.', $kk)] = ['key' => $kk];
    foreach ($columns as $cid) {
        foreach ($keys as $i => $kk) {
            $ln = $lens[$cid][$i];
            if ($pos + $ln > strlen($data)) throw new InvalidArgumentException('truncated');
            $out[implode('.', $kk)][$cid] = substr($data, $pos, $ln);
            $pos += $ln;
        }
    }
    if ($pos !== strlen($data)) throw new InvalidArgumentException('stage-B blob size');
    if (count($out) !== $n) throw new InvalidArgumentException('a brick twice');
    return $out;
}

/** [z, channels, tilesX, tilesY, [[offset, length]]] of a whole LPLN pack, tiles inside it. */
function lumen_v5_parse_plane_pack(string $data): array {
    if (strlen($data) < 16 || substr($data, 0, 4) !== LUMEN_MIG_PACK_MAGIC) throw new InvalidArgumentException('not a plane pack');
    $h = unpack('vver/vc/vtx/vty/Vz', $data, 4);
    if ($h['ver'] !== 1) throw new InvalidArgumentException('plane pack version');
    $n = $h['c'] * $h['tx'] * $h['ty'];
    $hb = 16 + 12 * $n;
    if (strlen($data) < $hb) throw new InvalidArgumentException('truncated plane pack header');
    $entries = [];
    for ($i = 0; $i < $n; $i++) {
        $e = unpack('Poff/Vlen', $data, 16 + 12 * $i);
        if ($e['len'] && ($e['off'] < $hb || $e['off'] + $e['len'] > strlen($data))) throw new InvalidArgumentException('tile outside the pack');
        $entries[] = [$e['off'], $e['len']];
    }
    return [$h['z'], $h['c'], $h['tx'], $h['ty'], $entries];
}

/**
 * The store content of a browser unit, checked (bad_blob): A → [k => LPLN pack or null];
 * B, C, D → bytes or null (dataset_migrations._m005_validate_put).
 */
function lumen_m005_validate_put(array $us, array $unit, string $body) {
    [$s, $t, $k, $c, $a, $b, $d] = $unit;
    $L = $us['levels'][$k];
    [$X, $Y, $Z] = [$L['dimensions']['x'], $L['dimensions']['y'], $L['dimensions']['z']];
    try {
        if ($s === 0) {
            if (strlen($body) < 4) throw new InvalidArgumentException('short');
            $n = unpack('V', $body, 0)[1];
            $nl = count($us['levels']);
            if ($n !== $nl - 1) throw new InvalidArgumentException("$n levels, expected " . ($nl - 1));
            if (strlen($body) < 4 + 8 * $n) throw new InvalidArgumentException('truncated');
            $pos = 4 + 8 * $n;
            $out = [];
            for ($i = 0; $i < $n; $i++) {
                $e = unpack('Vk/Vlen', $body, 4 + 8 * $i);
                $kk = $e['k']; $ln = $e['len'];
                if ($kk < 1 || $kk >= $nl || array_key_exists($kk, $out)) throw new InvalidArgumentException("level $kk");
                if ($pos + $ln > strlen($body)) throw new InvalidArgumentException('truncated');
                $data = substr($body, $pos, $ln);
                $pos += $ln;
                if ($ln) {
                    $dk = $us['levels'][$kk]['dimensions'];
                    [$zz, $cc, $ttx, $tty, $entries] = lumen_v5_parse_plane_pack($data);
                    if ([$zz, $cc, $ttx, $tty] !== [$a, 1, intdiv($dk['x'] + 511, 512), intdiv($dk['y'] + 511, 512)]) throw new InvalidArgumentException('plane pack header');
                    foreach ($entries as $i2 => [$off, $l2]) {
                        if (!$l2) continue;
                        $ty = intdiv($i2, $ttx); $tx = $i2 % $ttx;
                        $ih = lumen_mig_png_ihdr(substr($data, $off, min($l2, 64)));
                        if ($ih === null || [$ih[0], $ih[1]] !== [min(512, $dk['x'] - $tx * 512), min(512, $dk['y'] - $ty * 512)]) {
                            throw new InvalidArgumentException('tile size');
                        }
                    }
                }
                $out[$kk] = $ln ? $data : null;
            }
            if ($pos !== strlen($body)) throw new InvalidArgumentException('trailing bytes');
            return $out;
        }
        if ($body === '') return null;
        if ($s === 1) {
            $cols = lumen_m005_columns($k);
            [$gx, $gy, $gz] = [$L['gridSize']['x'], $L['gridSize']['y'], $L['gridSize']['z']];
            foreach (lumen_m005_parse_brick_blob($body, $cols) as $per) {
                [$bz, $by, $bx] = $per['key'];
                if ($bz < 4 * $a || $bz >= min($gz, 4 * $a + 4) || $by < 4 * $b || $by >= min($gy, 4 * $b + 4) || $bx < 4 * $d || $bx >= min($gx, 4 * $d + 4)) {
                    throw new InvalidArgumentException("brick ($bz, $by, $bx) outside the unit");
                }
                foreach ($cols as $cid) lumen_m005_check_brick($per[$cid], $cid);
            }
            return $body;
        }
        if ($s === 2) {
            $kind = LUMEN_M005_ORTH[$a];
            if (strlen($body) < LUMEN_V5_ORTH_HEADER || substr($body, 0, 4) !== LUMEN_V5_ORTH_MAGIC[$kind]) throw new InvalidArgumentException("not an $kind pack");
            $h = unpack('vver/vta/vtz/vres/Vfirst/Vcount', $body, 4);
            if ($h['ver'] !== 1) throw new InvalidArgumentException("$kind pack version");
            $n = $a === 0 ? $Y : $X; $width = $a === 0 ? $X : $Y;
            $first = $b * LUMEN_V5_ORTH_ROWS;
            if ([$h['first'], $h['count'], $h['ta'], $h['tz']] !== [$first, min($n, $first + LUMEN_V5_ORTH_ROWS) - $first, intdiv($width + 511, 512), intdiv($Z + 511, 512)]) {
                throw new InvalidArgumentException("$kind pack header");
            }
            $ne = $h['count'] * $h['ta'] * $h['tz'];
            $hb = LUMEN_V5_ORTH_HEADER + 12 * $ne;
            if (strlen($body) < $hb) throw new InvalidArgumentException("truncated $kind pack");
            for ($i = 0; $i < $ne; $i++) {
                $e = unpack('Poff/Vlen', $body, LUMEN_V5_ORTH_HEADER + 12 * $i);
                if ($e['len'] && ($e['off'] < $hb || $e['off'] + $e['len'] > strlen($body))) throw new InvalidArgumentException("$kind tile outside the pack");
            }
            return $body;
        }
        $bzd = lumen_v5_cut_depth($L['voxelSize']);
        if (strlen($body) < LUMEN_V5_CUT_RECORD_HEAD) throw new InvalidArgumentException('truncated cut record');
        [$mh, $mw] = lumen_v5_cut_mosaic_shape($bzd);
        for ($i = 0; $i < 512; $i++) {
            $e = unpack('Voff/Vlen', $body, 8 * $i);
            if (!$e['len']) continue;
            if ($e['off'] < LUMEN_V5_CUT_RECORD_HEAD || $e['off'] + $e['len'] > strlen($body)) throw new InvalidArgumentException('cut brick outside its record');
            [$ww, $hh, $lossless] = lumen_v5_webp_size(substr($body, $e['off'], $e['len']));
            if ([$ww, $hh, $lossless] !== [$mw, $mh, true]) throw new InvalidArgumentException("cut brick {$ww}x{$hh}");
        }
        return $body;
    } catch (InvalidArgumentException | ValueError $e) {
        throw new LumenMigError('bad_blob', 400, lumen_m005_key($unit) . ': ' . $e->getMessage());
    }
}

function lumen_m005_write(string $p, ?string $data): void {
    if ($data !== null && $data !== '') {
        if (!lumen_write_file_atomic($p, $data)) throw new LumenMigError('store_write_failed', 500);
    } elseif (is_file($p)) {
        @unlink($p);
    }
}

function lumen_m005_store(string $store, array $unit, $result): void {
    [$s, $t, $k, $c, $a] = $unit;
    if ($s === 0) {
        foreach ($result as $kk => $data) lumen_m005_write(lumen_m005_store_a($store, $t, (int)$kk, $c, $a), $data);
        return;
    }
    lumen_m005_write(lumen_m005_store_path($store, $unit), $result);
}

function lumen_m005_unit_put(array $plan, array $m, string $path, $key, string $body): array {
    $us = lumen_mig_unitset($plan, LUMEN_M005);
    $unit = lumen_m005_parse($key);
    [$s, $t, $k, $c] = $unit;
    $tree = $plan['trees'][$t] ?? null;
    if ($tree === null || $c >= $tree['C'] || $k >= count($us['levels'])) throw new LumenMigError('bad_unit');
    $ukey = lumen_m005_key($unit);
    if (!isset($us['unitBytes'][$ukey])) throw new LumenMigError('empty_unit', 409);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path, false);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    if (!lumen_m005_stage_ready($us, array_flip($j['done'] ?? []), $unit)) throw new LumenMigError('unit_blocked', 409, 'stage A of this tree/channel is not complete');
    $result = lumen_m005_validate_put($us, $unit, $body);
    unset($body);
    lumen_m005_store(lumen_mig_store_dir($plan['type'], $plan['folder'], LUMEN_M005), $unit, $result);
    $j = lumen_mig_mark_done($plan, $m, $path, [$ukey], 'browser');
    $sm = lumen_mig_summary($j);
    return ['ok' => true, 'done' => $sm['done'], 'total' => $sm['total']];
}

// ── m005, browser batches (dataset_migrations.unit_inputs_many / unit_put_many) ─

const LUMEN_M005_BATCH_MAX = 64;

function lumen_m005_unit_error($key, LumenMigError $e): array {
    $out = ['ok' => false, 'unit' => (string)$key, 'error' => $e->codeName, 'status' => $e->status];
    if ($e->detail !== null && $e->detail !== $e->codeName) $out['detail'] = substr($e->detail, 0, 300);
    return $out;
}

/** unit_inputs of up to 64 m005 (or m006: $mid) units in one answer: {ok, items: [answer or error, in order]}. */
function lumen_m005_unit_inputs_many(array $plan, string $path, $keys, string $mid = LUMEN_M005): array {
    if (!is_array($keys) || count($keys) < 1 || count($keys) > LUMEN_M005_BATCH_MAX || array_keys($keys) !== range(0, count($keys) - 1)) {
        throw new LumenMigError('bad_unit', 400, '1..' . LUMEN_M005_BATCH_MAX . ' units');
    }
    $items = [];
    foreach ($keys as $key) {
        try {
            $items[] = $mid === LUMEN_M005 ? lumen_m005_unit_inputs($plan, $path, $key) : lumen_m006_unit_inputs($plan, $key);
        } catch (LumenMigError $e) {
            $items[] = lumen_m005_unit_error($key, $e);
        }
    }
    return ['ok' => true, 'items' => $items];
}

/** [[key, body]] of a unit_put_many body: u32 n, n × {u16 key length, key, u32 length, body}. */
function lumen_m005_parse_put_many(string $body): array {
    $n = strlen($body);
    if ($n < 4) throw new LumenMigError('bad_blob', 400, 'unit_put_many: short');
    $count = unpack('V', $body, 0)[1];
    if ($count < 1 || $count > LUMEN_M005_BATCH_MAX) throw new LumenMigError('bad_blob', 400, "unit_put_many: $count units");
    $pos = 4; $out = [];
    for ($i = 0; $i < $count; $i++) {
        if ($pos + 2 > $n) throw new LumenMigError('bad_blob', 400, 'unit_put_many: truncated key');
        $kl = unpack('v', $body, $pos)[1]; $pos += 2;
        if ($pos + $kl + 4 > $n) throw new LumenMigError('bad_blob', 400, 'unit_put_many: truncated key');
        $key = substr($body, $pos, $kl); $pos += $kl;
        if (!preg_match('/^[\x20-\x7E]*$/D', $key)) throw new LumenMigError('bad_blob', 400, 'unit_put_many: key');
        $ln = unpack('V', $body, $pos)[1]; $pos += 4;
        if ($pos + $ln > $n) throw new LumenMigError('bad_blob', 400, 'unit_put_many: truncated body');
        $out[] = [$key, substr($body, $pos, $ln)];
        $pos += $ln;
    }
    if ($pos !== $n) throw new LumenMigError('bad_blob', 400, 'unit_put_many: trailing bytes');
    return $out;
}

/** Store several m005 unit results, journaled at once: {ok, results: [{unit, ok, error?}], done, total}. */
function lumen_m005_unit_put_many(array $plan, array $m, string $path, string $body): array {
    $entries = lumen_m005_parse_put_many($body);
    unset($body);
    $us = lumen_mig_unitset($plan, LUMEN_M005);
    $j = lumen_mig_load_journal($path);
    if ($j === null) throw new LumenMigError('no_job', 404);
    lumen_mig_check_source($plan, $j, $path, false);
    if (($j['state'] ?? null) !== 'running') throw new LumenMigError('job_not_running', 409);
    $done = array_flip($j['done'] ?? []);
    $store = lumen_mig_store_dir($plan['type'], $plan['folder'], LUMEN_M005);
    $results = []; $accepted = [];
    foreach ($entries as $i => [$key, $data]) {
        $entries[$i] = null;
        try {
            $unit = lumen_m005_parse($key);
            [$s, $t, $k, $c] = $unit;
            $tree = $plan['trees'][$t] ?? null;
            if ($tree === null || $c >= $tree['C'] || $k >= count($us['levels'])) throw new LumenMigError('bad_unit');
            $ukey = lumen_m005_key($unit);
            if (!isset($us['unitBytes'][$ukey])) throw new LumenMigError('empty_unit', 409);
            if (!lumen_m005_stage_ready($us, $done, $unit)) throw new LumenMigError('unit_blocked', 409, 'stage A of this tree/channel is not complete');
            lumen_m005_store($store, $unit, lumen_m005_validate_put($us, $unit, $data));
            $accepted[] = $ukey;
            // A stage-A unit of this batch counts for the later units of the same batch.
            $done[$ukey] = true;
            $results[] = ['ok' => true, 'unit' => $key];
        } catch (LumenMigError $e) {
            $results[] = lumen_m005_unit_error($key, $e);
        }
        unset($data);
    }
    if ($accepted) $j = lumen_mig_mark_done($plan, $m, $path, $accepted, 'browser');
    $sm = lumen_mig_summary($j);
    return ['ok' => true, 'results' => $results, 'done' => $sm['done'], 'total' => $sm['total']];
}

/** One piece of a unit result larger than one request may carry (dataset_migrations.unit_put_part). */
function lumen_m005_unit_put_part(array $plan, array $m, string $path, $key, $offset, $total, string $body): array {
    if (!is_numeric($offset) || !is_numeric($total)) throw new LumenMigError('bad_blob', 400, 'offset / total');
    $offset = (int)$offset; $total = (int)$total;
    if ($total < 1 || $total > LUMEN_MIG_MAX_BODY || $offset < 0 || $offset + strlen($body) > $total || $body === '') throw new LumenMigError('bad_blob', 400, 'piece outside the unit');
    $mid = $m['id'];
    if ($mid === LUMEN_M005) lumen_m005_parse($key); else lumen_m006_parse($key);
    // In the job's own store, so a cancel of that job drops its pieces too.
    $dir = lumen_mig_store_dir($plan['type'], $plan['folder'], $mid) . '/.parts';
    if (!is_dir($dir) && !admin_make_dir($dir)) throw new LumenMigError('store_write_failed', 500);
    $p = $dir . '/' . preg_replace('/[^A-Za-z0-9._-]/', '_', (string)$key) . '.part';
    clearstatcache(true, $p);
    $have = is_file($p) ? (int)filesize($p) : 0;
    if ($offset > $have) throw new LumenMigError('bad_blob', 409, "piece at $offset, $have bytes received");
    $fh = @fopen($p, is_file($p) ? 'r+b' : 'wb');
    if ($fh === false) throw new LumenMigError('store_write_failed', 500);
    fseek($fh, $offset);
    $ok = fwrite($fh, $body) === strlen($body);
    ftruncate($fh, $offset + strlen($body));
    fclose($fh);
    if (!$ok) throw new LumenMigError('store_write_failed', 500);
    if ($offset + strlen($body) < $total) return ['ok' => true, 'complete' => false, 'received' => $offset + strlen($body)];
    unset($body);
    $data = (string)file_get_contents($p);
    try {
        $out = $mid === LUMEN_M005 ? lumen_m005_unit_put($plan, $m, $path, $key, $data) : lumen_m006_unit_put($plan, $m, $path, $key, $data);
    } finally {
        @unlink($p);
    }
    return $out + ['complete' => true];
}

// ── m005 finalize: assembly of the v5 tree (dataset_migrations._m005_assemble) ─

function lumen_m005_entries_path(string $incoming, string $rel, string $name): string {
    return "$incoming/.entries/" . ($rel === '' ? '_' : $rel) . "/$name.bin";
}

/** dst = the bytes of src: a hard link (same volume, no copy), else a copy. */
function lumen_m005_link(string $src, string $dst): void {
    $dir = dirname($dst);
    if (!is_dir($dir) && !admin_make_dir($dir)) throw new LumenMigError('assembly_write_failed', 500, $dir);
    clearstatcache(true, $dst);
    if (is_file($dst)) {
        if ((int)filesize($dst) === (int)filesize($src)) return;
        @unlink($dst);
    }
    if (@link($src, $dst)) return;
    $tmp = $dir . '/.tmp-' . bin2hex(random_bytes(6));
    if (!@copy($src, $tmp) || !@rename($tmp, $dst)) { @unlink($tmp); throw new LumenMigError('assembly_write_failed', 500, $dst); }
}

/** One LPLN pack: tiles in entry order (c, ty, tx), null = all zero (format5.plane_pack). */
function lumen_v5_plane_pack(int $z, int $C, int $tx, int $ty, array $tiles): string {
    $n = $C * $ty * $tx;
    if (count($tiles) !== $n) throw new InvalidArgumentException('plane_pack: tile count');
    $head = LUMEN_MIG_PACK_MAGIC . pack('vvvvV', 1, $C, $tx, $ty, $z);
    $off = 16 + 12 * $n;
    $body = '';
    foreach ($tiles as $tile) {
        $ln = $tile === null ? 0 : strlen($tile);
        $head .= pack('PV', $ln ? $off : 0, $ln);
        $off += $ln;
        if ($ln) $body .= $tile;
    }
    return $head . $body;
}

/** An xz / yz pack of `count` all-zero rows: the header and its zero entries (format5.orth_pack of zeros). */
function lumen_v5_zero_orth_pack(string $kind, int $first, int $count, int $ta, int $tz): string {
    return LUMEN_V5_ORTH_MAGIC[$kind] . pack('vvvvVV', 1, $ta, $tz, 0, $first, $count) . str_repeat("\0", 12 * $count * $ta * $tz);
}

function lumen_m005_write_public(string $path, string $data): void {
    if (!lumen_write_file_atomic($path, $data)) throw new LumenMigError('assembly_write_failed', 500, $path);
}

/**
 * Write the v5 tree(s) into $incoming (SPEC §14.4–§14.5): every step writes its outputs and
 * then a marker, so a deadline only pauses it. [complete, steps done, steps total].
 */
function lumen_m005_assemble(array $plan, array $us, string $store, string $incoming, array $j, ?float $deadline): array {
    if (!is_dir($plan['dir'])) throw new LumenMigError('no_dataset', 404);
    $levels = $us['levels'];
    $ts = array_keys($plan['trees']);
    sort($ts);
    $C = $plan['trees'][$ts[0]]['C'];
    $steps = [];
    foreach ($ts as $t) {
        foreach ($levels as $k => $L) {
            for ($c = 0; $c < $C; $c++) $steps[] = ['cols', $t, $k, $c];
            if ($k) for ($z = 0; $z < $L['dimensions']['z']; $z++) $steps[] = ['xy', $t, $k, $z];
            for ($c = 0; $c < $C; $c++) {
                foreach ([[0, $L['dimensions']['y']], [1, $L['dimensions']['x']]] as [$kind, $n]) {
                    for ($b = 0, $nb = lumen_v5_orth_blocks($n); $b < $nb; $b++) $steps[] = ['orth', $t, $k, $c, $kind, $b];
                }
                $steps[] = ['cuts', $t, $k, $c];
            }
        }
    }
    $doneN = 0; $wrote = false; $v4 = [];
    $entrySize = LUMEN_V3_INDEX_ENTRY;
    foreach ($steps as $step) {
        [$kindS, $t] = $step;
        $tree = $plan['trees'][$t];
        $outDir = $tree['rel'] === '' ? $incoming : "$incoming/{$tree['rel']}";
        if ($kindS === 'cols') $marker = lumen_m005_entries_path($incoming, $tree['rel'], "cols.k{$step[2]}.c{$step[3]}");
        elseif ($kindS === 'xy') $marker = "$outDir/" . lumen_v5_xy_pack_rel($step[2], $step[3]);
        elseif ($kindS === 'orth') $marker = "$outDir/" . lumen_v5_orth_pack_rel(LUMEN_M005_ORTH[$step[4]], $step[2], $step[3], $step[5]);
        else $marker = lumen_m005_entries_path($incoming, $tree['rel'], "cuts.k{$step[2]}.c{$step[3]}");
        clearstatcache(true, $marker);
        if (is_file($marker)) { $doneN++; continue; }
        if ($wrote && $deadline !== null && microtime(true) > $deadline) return [false, $doneN, count($steps)];
        if (!is_dir($plan['dir'])) throw new LumenMigError('no_dataset', 404);
        $L = $levels[$step[2]];
        $dims = $L['dimensions'];
        if ($kindS === 'cols') {
            [, , $k, $c] = $step;
            [$gx, $gy, $gz] = [$L['gridSize']['x'], $L['gridSize']['y'], $L['gridSize']['z']];
            $n = $gx * $gy * $gz;
            $ents = [];
            foreach (LUMEN_V5_COLUMN_IDS as $cid) $ents[$cid] = [];
            $llRaw = null;
            if ($k === 0) {
                if (!isset($v4[$t])) {
                    $blob = (string)@file_get_contents("{$tree['bricksDir']}/index.bin");
                    $v4[$t] = [$blob, lumen_v3_parse_index($blob)];
                }
                [$blob, $idx] = $v4[$t];
                [$vgx, $vgy, $vgz] = $idx['levels'][0];
                $llRaw = substr($blob, $idx['entriesAt'][0] + $c * $vgx * $vgy * $vgz * $entrySize, $n * $entrySize);
                $packs = [];
                for ($i = 0; $i < $n; $i++) {
                    $e = unpack('vp/Vo/Vl', $llRaw, $entrySize * $i);
                    if ($e['l']) $packs[$e['p']] = true;
                }
                ksort($packs);
                foreach (array_keys($packs) as $pk) lumen_m005_link("{$tree['bricksDir']}/" . lumen_v3_pack_rel(0, $c, $pk), "$outDir/" . lumen_v5_brick_pack_rel(0, 'll', $c, $pk));
            }
            $cols = lumen_m005_columns($k);
            $writers = [];
            foreach ($cols as $cid) $writers[$cid] = new LumenV5PackWriter(fn($pk) => "$outDir/" . lumen_v5_brick_pack_rel($k, $cid, $c, $pk));
            try {
                for ($BZ = 0; $BZ < intdiv($gz + 3, 4); $BZ++) for ($BY = 0; $BY < intdiv($gy + 3, 4); $BY++) for ($BX = 0; $BX < intdiv($gx + 3, 4); $BX++) {
                    $p = lumen_m005_store_path($store, [1, $t, $k, $c, $BZ, $BY, $BX]);
                    $blob = is_file($p) ? @file_get_contents($p) : false;
                    if (!is_string($blob)) continue;
                    try {
                        $bricks = lumen_m005_parse_brick_blob($blob, $cols);
                    } catch (InvalidArgumentException $e) {
                        throw new LumenMigError('bad_tile', 500, "stage-B blob: " . $e->getMessage());
                    }
                    unset($blob);
                    uasort($bricks, fn($x, $y) => $x['key'] <=> $y['key']);
                    foreach ($cols as $cid) {
                        $placed = $writers[$cid]->addGroup(array_values(array_map(fn($r) => $r[$cid], $bricks)));
                        $i = 0;
                        foreach ($bricks as $r) {
                            [$bz, $by, $bx] = $r['key'];
                            $ents[$cid][($bz * $gy + $by) * $gx + $bx] = $placed[$i++];
                        }
                    }
                }
            } finally {
                foreach ($writers as $w) $w->close();
            }
            $marker_data = '';
            foreach (LUMEN_V5_COLUMN_IDS as $cid) {
                if ($cid === 'll' && $llRaw !== null) { $marker_data .= $llRaw; continue; }
                $s = '';
                for ($i = 0; $i < $n; $i++) {
                    $e = $ents[$cid][$i] ?? null;
                    $s .= $e === null ? "\0\0\0\0\0\0\0\0\0\0" : pack('vVV', $e[0], $e[1], $e[2]);
                }
                $marker_data .= $s;
            }
            lumen_m005_write_public($marker, $marker_data);
        } elseif ($kindS === 'xy') {
            [, , $k, $z] = $step;
            $txn = intdiv($dims['x'] + 511, 512); $tyn = intdiv($dims['y'] + 511, 512);
            $tiles = [];
            for ($c = 0; $c < $C; $c++) {
                $p = lumen_m005_store_a($store, $t, $k, $c, $z);
                $data = is_file($p) ? @file_get_contents($p) : false;
                if (!is_string($data)) { for ($i = 0; $i < $txn * $tyn; $i++) $tiles[] = null; continue; }
                try {
                    [, , , , $entries] = lumen_v5_parse_plane_pack($data);
                } catch (InvalidArgumentException $e) {
                    throw new LumenMigError('bad_tile', 500, "stage-A plane: " . $e->getMessage());
                }
                foreach ($entries as [$off, $ln]) $tiles[] = $ln ? substr($data, $off, $ln) : null;
            }
            lumen_m005_write_public($marker, lumen_v5_plane_pack($z, $C, $txn, $tyn, $tiles));
        } elseif ($kindS === 'orth') {
            [, , $k, $c, $kind, $b] = $step;
            $src = lumen_m005_store_path($store, [2, $t, $k, $c, $kind, $b, 0]);
            if (is_file($src)) {
                $data = @file_get_contents($src);
                if (!is_string($data)) throw new LumenMigError('bad_tile', 500, 'stage-C pack unreadable');
                lumen_m005_write_public($marker, $data);
            } else {
                $n = $kind === 0 ? $dims['y'] : $dims['x'];
                $first = $b * LUMEN_V5_ORTH_ROWS;
                $count = min($n, $first + LUMEN_V5_ORTH_ROWS) - $first;
                $width = $kind === 0 ? $dims['x'] : $dims['y'];
                lumen_m005_write_public($marker, lumen_v5_zero_orth_pack(LUMEN_M005_ORTH[$kind], $first, $count, intdiv($width + 511, 512), intdiv($dims['z'] + 511, 512)));
            }
        } else {
            [, , $k, $c] = $step;
            $bzd = lumen_v5_cut_depth($L['voxelSize']);
            [$sgx, $sgy, $sgz] = lumen_v5_cut_super_grid($dims, $bzd);
            $ents = [];
            $w = new LumenV5PackWriter(fn($pk) => "$outDir/" . lumen_v5_cut_pack_rel($k, $c, $pk), 1 << 30, LUMEN_V5_CUT_PACK_MAX_BYTES);
            try {
                for ($SZ = 0; $SZ < $sgz; $SZ++) for ($SY = 0; $SY < $sgy; $SY++) for ($SX = 0; $SX < $sgx; $SX++) {
                    $p = lumen_m005_store_path($store, [3, $t, $k, $c, $SZ, $SY, $SX]);
                    $rec = is_file($p) ? @file_get_contents($p) : false;
                    if (!is_string($rec)) continue;
                    $ents[($SZ * $sgy + $SY) * $sgx + $SX] = $w->addGroup([$rec])[0];
                }
            } finally {
                $w->close();
            }
            $s = '';
            for ($i = 0, $n = $sgx * $sgy * $sgz; $i < $n; $i++) {
                $e = $ents[$i] ?? null;
                $s .= $e === null ? "\0\0\0\0\0\0\0\0\0\0" : pack('vVV', $e[0], $e[1], $e[2]);
            }
            lumen_m005_write_public($marker, $s);
        }
        $doneN++;
        $wrote = true;
    }
    // Indexes and manifest (cheap: rewritten on every complete pass).
    $treesDoc = [];
    foreach ($ts as $t) {
        $tree = $plan['trees'][$t];
        $outDir = $tree['rel'] === '' ? $incoming : "$incoming/{$tree['rel']}";
        $colEntries = []; $colLevels = [];
        $nbytes = []; $stored = [];
        foreach ($levels as $k => $L) {
            [$gx, $gy, $gz] = [$L['gridSize']['x'], $L['gridSize']['y'], $L['gridSize']['z']];
            $n = $gx * $gy * $gz;
            $per = [];
            for ($c = 0; $c < $C; $c++) {
                $raw = (string)@file_get_contents(lumen_m005_entries_path($incoming, $tree['rel'], "cols.k$k.c$c"));
                if (strlen($raw) !== $n * $entrySize * count(LUMEN_V5_COLUMN_IDS)) throw new LumenMigError('assembly_invalid', 500, "entries k$k c$c");
                foreach (LUMEN_V5_COLUMN_IDS as $i => $cid) $per[$cid][$c] = substr($raw, $i * $n * $entrySize, $n * $entrySize);
            }
            $nbytes[(string)$k] = [];
            $storedK = 0;
            foreach (LUMEN_V5_COLUMN_IDS as $cid) {
                $packs = 0; $perC = [];
                for ($c = 0; $c < $C; $c++) {
                    [$p, $bytes, $st] = lumen_v5_entries_stats($per[$cid][$c]);
                    $packs += $p;
                    $perC[] = $bytes;
                    if ($cid === 'll') $storedK += $st;
                }
                $colEntries[$cid][$k] = $per[$cid];
                $colLevels[$cid][$k] = [$gx, $gy, $gz, $packs];
                $nbytes[(string)$k][$cid] = $perC;
            }
            $stored[] = $storedK;
        }
        $columnRefs = [];
        foreach (LUMEN_V5_COLUMN_IDS as $cid) {
            $blob = lumen_v5_index_bytes($colLevels[$cid], $C, $colEntries[$cid]);
            lumen_m005_write_public("$outDir/" . lumen_v5_index_rel($cid), $blob);
            $columnRefs[$cid] = ['bytes' => strlen($blob), 'sha256' => hash('sha256', $blob)];
        }
        $cutRefs = [];
        foreach ($levels as $k => $L) {
            $bzd = lumen_v5_cut_depth($L['voxelSize']);
            [$sgx, $sgy, $sgz] = lumen_v5_cut_super_grid($L['dimensions'], $bzd);
            $n = $sgx * $sgy * $sgz;
            $e = []; $packs = 0;
            for ($c = 0; $c < $C; $c++) {
                $e[$c] = (string)@file_get_contents(lumen_m005_entries_path($incoming, $tree['rel'], "cuts.k$k.c$c"));
                if (strlen($e[$c]) !== $n * $entrySize) throw new LumenMigError('assembly_invalid', 500, "cut entries k$k c$c");
                $packs += lumen_v5_entries_stats($e[$c])[0];
            }
            $blob = lumen_v5_index_bytes([[$sgx, $sgy, $sgz, $packs]], $C, [$e]);
            lumen_m005_write_public("$outDir/" . lumen_v5_cut_index_rel($k), $blob);
            $cutRefs[] = ['bytes' => strlen($blob), 'sha256' => hash('sha256', $blob)];
        }
        $treesDoc[$tree['rel']] = ['index' => ['columns' => $columnRefs, 'cuts' => $cutRefs], 'bytes' => $nbytes, 'stored' => $stored];
    }
    $v4man = json_decode((string)@file_get_contents($plan['manifestPath']));
    $hist = is_object($v4man) && property_exists($v4man, 'histograms') ? $v4man->histograms : null;
    $tph = is_object($v4man) && isset($v4man->timepointHistograms) && is_object($v4man->timepointHistograms) ? $v4man->timepointHistograms : null;
    $dataset = is_object($v4man) && isset($v4man->dataset) && is_string($v4man->dataset) ? $v4man->dataset : null;
    $doc = lumen_v5_manifest($levels, $C, $treesDoc, $hist, $j['assembledAt'] ?? lumen_mig_now(), $tph, $dataset,
                             (string)($j['producer'] ?? lumen_mig_producer($j)));
    lumen_m005_write_public("$incoming/manifest.json", lumen_v5_manifest_bytes($doc));
    return [true, $doneN, count($steps)];
}

/** {columns: {cid: {url, bytes, sha256}}, cuts: [...]} with the tree's url prefix (format5.tree_index_doc). */
function lumen_v5_tree_index_doc(string $rel, array $columnRefs, array $cutRefs): array {
    $pre = $rel === '' ? '' : "$rel/";
    $cols = [];
    foreach (LUMEN_V5_COLUMN_IDS as $cid) $cols[$cid] = ['url' => $pre . lumen_v5_index_rel($cid)] + $columnRefs[$cid];
    $cuts = [];
    foreach ($cutRefs as $k => $ref) $cuts[] = ['url' => $pre . lumen_v5_cut_index_rel($k)] + $ref;
    return ['columns' => $cols, 'cuts' => $cuts];
}

/** bytes[level][cid] = per-channel list, as a JSON object keyed by level. */
function lumen_v5_bytes_obj(array $bytes): object {
    $o = new stdClass();
    foreach ($bytes as $lv => $perCol) $o->{(string)$lv} = (object)$perCol;
    return $o;
}

/** bricks/manifest.json of a v5 tree (format5.manifest_v5), keys in its order. */
function lumen_v5_manifest(array $levels, int $C, array $trees, $histograms, string $createdAt, $tph, ?string $dataset, string $producer): array {
    $keys = array_map('strval', array_keys($trees));
    sort($keys, SORT_STRING);
    $live = $keys !== [''];
    $doc = ['schema' => LUMEN_V5_SCHEMA, 'version' => 5, 'formatVersion' => 5];
    if ($dataset !== null && $dataset !== '') $doc['dataset'] = $dataset;
    $rows = [];
    foreach ($levels as $k => $L) {
        $n = 0;
        foreach ($keys as $t) $n += $trees[$t]['stored'][$k];
        $rows[] = ['level' => $k, 'target' => $L['target'], 'dimensions' => $L['dimensions'], 'voxelSize' => $L['voxelSize'],
                   'gridSize' => $L['gridSize'], 'brickCount' => $n];
    }
    $doc += ['channels' => $C, 'brickSize' => 64, 'apron' => 1, 'levels' => $rows, 'columns' => lumen_v5_manifest_columns(),
             'stores' => lumen_v5_stores_doc($levels)];
    $withUrls = fn(string $rel, array $tree) => lumen_v5_tree_index_doc($rel, $tree['index']['columns'], $tree['index']['cuts']);
    if ($live) {
        $doc['index'] = null;
        $doc['timepoints'] = array_map(fn($k) => ['path' => $k, 'index' => $withUrls($k, $trees[$k]), 'bytes' => lumen_v5_bytes_obj($trees[$k]['bytes'])], $keys);
        $worst = [];
        foreach ($keys as $k) foreach ($trees[$k]['bytes'] as $lv => $perCol) foreach ($perCol as $cid => $perC) {
            $cur = $worst[$lv][$cid] ?? array_fill(0, count($perC), 0);
            foreach ($perC as $i => $v) $cur[$i] = max($cur[$i], $v);
            $worst[$lv][$cid] = $cur;
        }
        $doc['bytes'] = lumen_v5_bytes_obj($worst);
    } else {
        $doc['index'] = $withUrls('', $trees['']);
        $doc['timepoints'] = null;
        $doc['bytes'] = lumen_v5_bytes_obj($trees['']['bytes']);
    }
    $doc['histograms'] = $histograms;
    if ($live && $tph !== null) {
        $sel = new stdClass();
        foreach ($keys as $k) if (isset($tph->{$k})) $sel->{$k} = $tph->{$k};
        $doc['timepointHistograms'] = $sel;
    }
    $doc['producer'] = $producer;
    $doc['createdAt'] = $createdAt;
    return $doc;
}

function lumen_v5_manifest_bytes(array $doc): string {
    $s = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($s === false) throw new LumenMigError('assembly_write_failed', 500, 'manifest json');
    return $s;
}

/** Every tree of an assembled v5 (v6: $fmt 6, null = either) manifest checked, or the first problem (format5.bricks_problem). */
function lumen_v5_problem_of(string $bricksDir, ?int $fmt = 5): ?string {
    $doc = admin_read_json("$bricksDir/manifest.json");
    $have = is_array($doc) ? lumen_v5_schema_format($doc['schema'] ?? null) : null;
    if ($have === null || ($fmt !== null && $have !== $fmt)) return 'not a v' . ($fmt ?? '5/6') . ' manifest';
    foreach (lumen_v5_tree_rels($doc) as $rel) {
        $p = lumen_v5_tree_problem($bricksDir, $doc, is_string($rel) ? $rel : '');
        if ($p !== null) return $p;
    }
    return null;
}

/**
 * Assemble the v5 tree, validate, swap bricks/, re-stamp planes/ and mips/, bump to 5, delete
 * bricks.v4-old/ — or keep it as bricks.previous/ (dataset_migrations._finalize_m005).
 */
function lumen_m005_finalize(array $m, $datasetId, float $deadline, bool $keepPrevious = false): array {
    [$type, $folder, $ds] = lumen_mig_resolve($datasetId);
    $path = lumen_mig_journal_path($type, $folder, LUMEN_M005);
    $base = lumen_mig_job_base($type, $folder, LUMEN_M005);
    [$incName, , $oldName] = LUMEN_MIG_SWAP_DIRS[LUMEN_M005];
    $incoming = "$ds/$incName"; $live = "$ds/bricks"; $old = "$ds/$oldName";
    return lumen_mig_with_job_lock($base, function () use ($m, $datasetId, $type, $folder, $ds, $path, $deadline, $incoming, $live, $old, $oldName, $keepPrevious) {
        $j = lumen_mig_load_journal($path);
        if ($j === null) {
            $plan = lumen_mig_plan_for($datasetId);
            if (in_array($plan['type'], $m['types'], true) && !empty($plan['v5']) && $plan['v5Problem'] === null) {
                $oldSha = is_file("$old/manifest.json") ? hash_file('sha256', "$old/manifest.json") : null;
                lumen_mig_restamp_derived($plan, $oldSha);
                $fv = lumen_mig_bump_metadata($ds, $m['to']);
                lumen_mig_retire_old_bricks($ds, $keepPrevious, $oldName);
                return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
            }
            throw new LumenMigError('no_job', 404);
        }
        $state = $j['state'] ?? null;
        if ($state === 'assembling' && (lumen_mig_bricks_dir_schema($live) === LUMEN_V5_SCHEMA || (!file_exists($live) && is_dir($incoming)))) $state = 'swapped';
        $plan = null;
        if ($state === 'running' || $state === 'assembling') {
            $plan = lumen_mig_plan_for($datasetId);
            lumen_mig_check_source($plan, $j, $path);
        }
        if ($state === 'running') {
            $us = lumen_mig_unitset($plan, LUMEN_M005);
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
            $us = lumen_mig_unitset($plan, LUMEN_M005);
            $store = lumen_mig_store_dir($type, $folder, LUMEN_M005);
            [$complete, $written, $total] = lumen_m005_assemble($plan, $us, $store, $incoming, $j, $deadline);
            if (!$complete) {
                $j['assembly'] = ['steps' => $total, 'written' => $written];
                lumen_mig_save_journal($path, $j);
                return ['ok' => true, 'complete' => false, 'assembly' => $j['assembly']];
            }
            lumen_mig_rrmdir("$incoming/.entries");
            $problem = lumen_v5_problem_of($incoming);
            if ($problem !== null) throw new LumenMigError('assembly_invalid', 500, $problem);
            lumen_mig_check_source($plan, $j, $path);
            $j['oldManifestSha'] = $plan['sha'];
            lumen_mig_swap_bricks($ds, LUMEN_M005);
            $j['state'] = 'swapped';
            unset($j['assembly']);
            lumen_mig_save_journal($path, $j);
            $state = 'swapped';
        }
        if ($state === 'swapped') {
            lumen_mig_swap_bricks($ds, LUMEN_M005);
            if (($j['state'] ?? null) !== 'swapped') { $j['state'] = 'swapped'; lumen_mig_save_journal($path, $j); }
            $plan = lumen_mig_plan_for($datasetId);
            if (empty($plan['v5']) || $plan['v5Problem'] !== null) {
                $j['state'] = 'failed';
                $j['error'] = 'assembly_invalid';
                lumen_mig_save_journal($path, $j);
                throw new LumenMigError('assembly_invalid', 500, $plan['v5Problem'] ?? 'not a v5 tree');
            }
            $oldSha = $j['oldManifestSha'] ?? null;
            if ($oldSha === null && is_file("$old/manifest.json")) $oldSha = hash_file('sha256', "$old/manifest.json");
            lumen_mig_restamp_derived($plan, $oldSha);
            $fv = lumen_mig_bump_metadata($ds, $m['to']);
            lumen_mig_retire_old_bricks($ds, $keepPrevious, $oldName);
            lumen_mig_rrmdir(lumen_mig_store_dir($type, $folder, LUMEN_M005));
            @unlink($path);
            return ['ok' => true, 'complete' => true, 'formatVersion' => $fv];
        }
        throw new LumenMigError('job_failed', 409, (string)($j['error'] ?? $state));
    });
}
