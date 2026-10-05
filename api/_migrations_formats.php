<?php
/**
 * Lumen3D — codecs of dataset formats 3 and 4 (PHP twin of the arithmetic in
 * dataset_migrations.py and preprocess/bricks_v3_writer.py)
 * ===========================================================================
 * Contract: DOCS/dataset-migrations/SPEC.md §12–§13. Pure functions over byte strings —
 * no file system, no journal — so every one of them is checked against the Python twin
 * byte for byte (tests/test_v3_php_*.php, tests/test_v3_php_parity.py).
 *
 * PHP has no vector type, and a shared host gives a request 128 MiB and 30–60 s. The
 * per-voxel work is therefore done by C-level string primitives wherever an exact
 * formulation exists:
 *  - per-voxel MAXIMUM of N planes (format 3) by bit slicing: strtr() maps every byte to
 *    0xFF/0x00 by one of its bits, and the maximum is decided most significant bit first
 *    with string &, |, ~ (lumen_mig_bytes_max);
 *  - the 2×2(×2) integer MEAN of format 4 by SWAR on 64-bit words: unpack('P*') turns 8
 *    voxels into one int, even and odd bytes are summed in 16-bit lanes (≤ 8·255 = 2040,
 *    no lane overflows), rounded half up by adding n/2 and shifting by log2 n, and the
 *    lanes are compacted back to bytes (lumen_v3_reduce_rows).
 *
 * This file is an include (leading underscore ⇒ denied over HTTP by api/.htaccess and
 * router.php).
 */
declare(strict_types=1);

const LUMEN_V3_SCHEMA         = 'iribhm-bricks-v3';
const LUMEN_V3_BRICK          = 64;
const LUMEN_V3_APRON          = 1;
const LUMEN_V3_SLICE          = 66;          // BRICK + 2·APRON
const LUMEN_V3_COLS           = 9;
const LUMEN_V3_ROWS           = 8;
const LUMEN_V3_MOSAIC_W       = 594;         // COLS · SLICE
const LUMEN_V3_MOSAIC_H       = 528;         // ROWS · SLICE
const LUMEN_V3_PACK_MAX_BRICKS = 64;
const LUMEN_V3_PACK_MAX_BYTES = 16777216;    // 16 MiB
const LUMEN_V3_MIN_COARSE     = 128;
const LUMEN_V3_Z_ISOTROPY     = 1.5;
const LUMEN_V3_INDEX_MAGIC    = 'LBIX';
const LUMEN_V3_INDEX_VERSION  = 1;
const LUMEN_V3_INDEX_HEADER   = 12;
const LUMEN_V3_INDEX_LEVEL    = 16;
const LUMEN_V3_INDEX_ENTRY    = 10;
const LUMEN_MIPS_SCHEMA       = 'lumen-mips-v1';
const LUMEN_MIPS_MAGIC        = 'LMIP';
const LUMEN_MIPS_LAYER        = 64;

// ── PNG (greyscale, 8-bit): validated inflate and decode ─────────────────────

/**
 * The inflated, still filtered scanlines (h · (w+1) bytes) of a png-gray8 tile, after
 * the full structural check of SPEC §3.3 (signature, IHDR first, only IHDR/IDAT/IEND,
 * every CRC, exact inflated size, filter types 0..4). InvalidArgumentException otherwise.
 */
function lumen_mig_png_scanlines(string $png, int $w, int $h): string {
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
    $stride = $w + 1;
    for ($y = 0; $y < $h; $y++) if (ord($raw[$y * $stride]) > 4) throw new InvalidArgumentException('bad filter type');
    return $raw;
}

/**
 * The $w × $h pixels of a png-gray8 tile. Every producer of the platform writes filter
 * None (SPEC §3.3), which is a plain substring per row; the four other filters are
 * reconstructed per byte as the PNG specification defines them (1 byte per pixel).
 */
function lumen_mig_png_decode_gray(string $png, int $w, int $h): string {
    $raw = lumen_mig_png_scanlines($png, $w, $h);
    $stride = $w + 1;
    $rows = [];
    $prev = null;                                   // previous row as ints (only for filters 2..4)
    for ($y = 0; $y < $h; $y++) {
        $f = ord($raw[$y * $stride]);
        $line = substr($raw, $y * $stride + 1, $w);
        if ($f === 0) {
            $rows[] = $line;
            $prev = null;
            continue;
        }
        $up = $prev ?? ($y > 0 ? array_values(unpack('C*', $rows[$y - 1])) : array_fill(0, $w, 0));
        $cur = array_values(unpack('C*', $line));
        for ($x = 0; $x < $w; $x++) {
            $a = $x > 0 ? $cur[$x - 1] : 0;
            $b = $up[$x];
            switch ($f) {
                case 1: $cur[$x] = ($cur[$x] + $a) & 255; break;
                case 2: $cur[$x] = ($cur[$x] + $b) & 255; break;
                case 3: $cur[$x] = ($cur[$x] + (($a + $b) >> 1)) & 255; break;
                default:
                    $c = $x > 0 ? $up[$x - 1] : 0;
                    $p = $a + $b - $c;
                    $pa = abs($p - $a); $pb = abs($p - $b); $pc = abs($p - $c);
                    $cur[$x] = ($cur[$x] + (($pa <= $pb && $pa <= $pc) ? $a : ($pb <= $pc ? $b : $c))) & 255;
            }
        }
        $rows[] = pack('C*', ...$cur);
        $prev = $cur;
    }
    return implode('', $rows);
}

// ── Format 3: per-voxel maximum ──────────────────────────────────────────────

/** [identity, bit0…bit7]: strtr tables mapping a byte to 0xFF when bit i is set, else 0x00. */
function lumen_mig_bit_luts(): array {
    static $luts = null;
    if ($luts !== null) return $luts;
    $id = '';
    for ($v = 0; $v < 256; $v++) $id .= chr($v);
    $luts = [$id];
    for ($i = 0; $i < 8; $i++) {
        $s = '';
        for ($v = 0; $v < 256; $v++) $s .= (($v >> $i) & 1) ? "\xFF" : "\x00";
        $luts[] = $s;
    }
    return $luts;
}

/**
 * Per-byte maximum of equally long strings, exact. Bit slicing, most significant bit
 * first: M_i = OR over the planes still tied with the maximum on the higher bits of
 * their bit i; a plane whose bit i is 0 where M_i is 1 stops being a candidate there.
 * The maximum is the concatenation of the M_i. Each step is one C pass over a string,
 * ~1.7× fewer passes than folding the planes pairwise (and a plane that can no longer
 * reach the maximum anywhere is dropped).
 */
function lumen_mig_bytes_max(array $planes): string {
    $planes = array_values($planes);
    if (!$planes) throw new InvalidArgumentException('bytes_max: no plane');
    $n = strlen($planes[0]);
    foreach ($planes as $p) if (strlen($p) !== $n) throw new InvalidArgumentException('bytes_max: planes differ in length');
    if (count($planes) === 1 || $n === 0) return $planes[0];
    $luts = lumen_mig_bit_luts();
    $zero = str_repeat("\0", $n);
    $cand = array_fill(0, count($planes), ~$zero);
    $max = $zero;
    for ($i = 7; $i >= 0; $i--) {
        $mi = $zero; $bits = [];
        foreach ($cand as $k => $ck) {
            $b = strtr($planes[$k], $luts[0], $luts[$i + 1]);
            $bits[$k] = $b;
            $mi |= $ck & $b;
        }
        if (strspn($mi, "\0") === $n) continue;           // no candidate has bit i: all stay tied
        $max |= $mi & str_repeat(chr(1 << $i), $n);
        $notMi = ~$mi;
        foreach ($bits as $k => $b) {
            $ck = $cand[$k] & ($b | $notMi);
            if (strspn($ck, "\0") === $n) unset($cand[$k]); else $cand[$k] = $ck;
        }
        unset($bits);
    }
    return $max;
}

// ── Format 4: levels, mean reduction ─────────────────────────────────────────

/** (vx, vy, vz) µm, or (1, 1, 1) when the declared calibration is unusable. */
function lumen_v3_usable_voxel($voxel): array {
    $v = null;
    if (is_array($voxel)) {
        $v = array_key_exists('x', $voxel) ? [$voxel['x'] ?? null, $voxel['y'] ?? null, $voxel['z'] ?? null] : array_values($voxel);
    }
    if (!is_array($v) || count($v) !== 3) return [1.0, 1.0, 1.0];
    $out = [];
    foreach ($v as $a) {
        if (is_string($a) && is_numeric($a)) $a = (float)$a;
        if (!is_int($a) && !is_float($a)) return [1.0, 1.0, 1.0];
        $a = (float)$a;
        if (!is_finite($a) || $a <= 0) return [1.0, 1.0, 1.0];
        $out[] = $a;
    }
    return $out;
}

/**
 * The level ladder of a tree (SPEC §13.1; twin of bricks_v3_writer.level_ladder):
 * [{level, dimensions{x,y,z}, voxelSize{x,y,z}, halveZ}]. Level k+1 halves X and Y
 * (ceil, voxel sides doubled) and halves Z iff vz_k ≤ 1.5 · max(vx, vy)_{k+1}; levels are
 * added while the coarsest is wider than 128 in X or Y.
 */
function lumen_v3_ladder(int $X, int $Y, int $Z, $voxel): array {
    [$vx, $vy, $vz] = lumen_v3_usable_voxel($voxel);
    $out = [['level' => 0, 'dimensions' => ['x' => $X, 'y' => $Y, 'z' => $Z],
             'voxelSize' => ['x' => $vx, 'y' => $vy, 'z' => $vz], 'halveZ' => false]];
    while (max($X, $Y) > LUMEN_V3_MIN_COARSE) {
        $vx = 2.0 * $vx; $vy = 2.0 * $vy;
        $halve = $vz <= LUMEN_V3_Z_ISOTROPY * max($vx, $vy);
        $X = intdiv($X + 1, 2); $Y = intdiv($Y + 1, 2);
        if ($halve) { $Z = intdiv($Z + 1, 2); $vz = 2.0 * $vz; }
        $out[] = ['level' => count($out), 'dimensions' => ['x' => $X, 'y' => $Y, 'z' => $Z],
                  'voxelSize' => ['x' => $vx, 'y' => $vy, 'z' => $vz], 'halveZ' => $halve];
    }
    return $out;
}

/** [gx, gy, gz] bricks of a level. */
function lumen_v3_grid(array $dims): array {
    return [intdiv($dims['x'] + 63, 64), intdiv($dims['y'] + 63, 64), intdiv($dims['z'] + 63, 64)];
}

/**
 * One output row of the 2×2(×2) mean: $rows = the 2 (Z kept) or 4 (Z halved) source rows
 * of the block, each 2·$ow bytes long, the voxel past an odd edge already REPLICATED by
 * the caller. Replication is exact: duplicating the existing voxels of an edge block
 * multiplies its sum and its count by the same power of two, and (2^k·S + 2^k·n/2) >>
 * log2(2^k·n) = (S + n/2) // n. So every block is a full one, n = 2·count($rows).
 * SWAR: 8 voxels per int; even and odd bytes summed in 16-bit lanes (masking after the
 * arithmetic right shift drops its sign fill), + n/2, >> log2 n, lanes compacted to bytes.
 */
function lumen_v3_reduce_rows(array $rows, int $ow): string {
    $nr = count($rows);
    if ($nr !== 2 && $nr !== 4) throw new InvalidArgumentException('reduce_rows: 2 or 4 rows');
    $sh = $nr === 4 ? 3 : 2;
    $H = ($nr === 4 ? 4 : 2) * 0x0001000100010001;
    $M = 0x00FF00FF00FF00FF;
    $len = 2 * $ow;
    $pad = (16 - $len % 16) % 16;
    $W = [];
    foreach ($rows as $r) {
        if (strlen($r) !== $len) throw new InvalidArgumentException('reduce_rows: row length');
        $W[] = unpack('P*', $pad ? $r . str_repeat("\0", $pad) : $r);   // 1-based
    }
    $cnt = intdiv($len + $pad, 8);
    $out = [];
    if ($nr === 4) {
        [$a, $b, $c, $d] = $W;
        for ($i = 1; $i <= $cnt; $i += 2) {
            $p = $a[$i]; $q = $b[$i]; $r = $c[$i]; $u = $d[$i];
            $s = ($p & $M) + (($p >> 8) & $M) + ($q & $M) + (($q >> 8) & $M) + ($r & $M) + (($r >> 8) & $M) + ($u & $M) + (($u >> 8) & $M);
            $s = (($s + $H) >> $sh) & $M; $s = ($s | ($s >> 8)) & 0x0000FFFF0000FFFF; $lo = ($s | ($s >> 16)) & 0xFFFFFFFF;
            $p = $a[$i + 1]; $q = $b[$i + 1]; $r = $c[$i + 1]; $u = $d[$i + 1];
            $s = ($p & $M) + (($p >> 8) & $M) + ($q & $M) + (($q >> 8) & $M) + ($r & $M) + (($r >> 8) & $M) + ($u & $M) + (($u >> 8) & $M);
            $s = (($s + $H) >> $sh) & $M; $s = ($s | ($s >> 8)) & 0x0000FFFF0000FFFF; $s = ($s | ($s >> 16)) & 0xFFFFFFFF;
            $out[] = $lo | ($s << 32);
        }
    } else {
        [$a, $b] = $W;
        for ($i = 1; $i <= $cnt; $i += 2) {
            $p = $a[$i]; $q = $b[$i];
            $s = ($p & $M) + (($p >> 8) & $M) + ($q & $M) + (($q >> 8) & $M);
            $s = (($s + $H) >> $sh) & $M; $s = ($s | ($s >> 8)) & 0x0000FFFF0000FFFF; $lo = ($s | ($s >> 16)) & 0xFFFFFFFF;
            $p = $a[$i + 1]; $q = $b[$i + 1];
            $s = ($p & $M) + (($p >> 8) & $M) + ($q & $M) + (($q >> 8) & $M);
            $s = (($s + $H) >> $sh) & $M; $s = ($s | ($s >> 8)) & 0x0000FFFF0000FFFF; $s = ($s | ($s >> 16)) & 0xFFFFFFFF;
            $out[] = $lo | ($s << 32);
        }
    }
    return substr(pack('P*', ...$out), 0, $ow);
}

/**
 * One output plane (ow × oh) of the next level from 1 or 2 source planes (sw × sh,
 * row-major) — the source planes of a block, Z pair or single plane when Z is kept.
 * Output voxel (x, y) averages source x ∈ {2x, 2x+1}, y ∈ {2y, 2y+1} clamped to the
 * source plane (an odd edge replicates, see lumen_v3_reduce_rows).
 */
function lumen_v3_reduce_plane(array $planes, int $sw, int $sh, int $ow, int $oh): string {
    $rowsOut = [];
    $odd = (2 * $ow) > $sw;                          // the last output column has one source column
    foreach ($planes as $p) if (strlen($p) !== $sw * $sh) throw new InvalidArgumentException('reduce_plane: plane size');
    for ($y = 0; $y < $oh; $y++) {
        $y0 = 2 * $y; $y1 = min(2 * $y + 1, $sh - 1);
        $rows = [];
        foreach ($planes as $p) {
            foreach ([$y0, $y1] as $yy) {
                $r = substr($p, $yy * $sw, $sw);
                if ($odd) $r .= $r[$sw - 1];
                $rows[] = $r;
            }
        }
        $rowsOut[] = lumen_v3_reduce_rows($rows, $ow);
    }
    return implode('', $rowsOut);
}

// ── Format 4: the 66³ brick, its 9×8 mosaic, lossless WebP ───────────────────

/** 594 × 528 greyscale mosaic of a 66³ brick (z-major; slice s at column s % 9, row s // 9; 6 last slots 0). */
function lumen_v3_mosaic(string $brick): string {
    $S = LUMEN_V3_SLICE;
    if (strlen($brick) !== $S * $S * $S) throw new InvalidArgumentException('mosaic: not a 66³ brick');
    $zeroRow = str_repeat("\0", $S);
    $rows = [];
    for ($R = 0; $R < LUMEN_V3_ROWS; $R++) {
        for ($yy = 0; $yy < $S; $yy++) {
            $line = '';
            for ($col = 0; $col < LUMEN_V3_COLS; $col++) {
                $s = $R * LUMEN_V3_COLS + $col;
                $line .= $s < $S ? substr($brick, ($s * $S + $yy) * $S, $S) : $zeroRow;
            }
            $rows[] = $line;
        }
    }
    return implode('', $rows);
}

/** Inverse of lumen_v3_mosaic. */
function lumen_v3_unmosaic(string $img): string {
    $S = LUMEN_V3_SLICE; $W = LUMEN_V3_MOSAIC_W;
    if (strlen($img) !== $W * LUMEN_V3_MOSAIC_H) throw new InvalidArgumentException('unmosaic: not a 594×528 image');
    $out = [];
    for ($s = 0; $s < $S; $s++) {
        $R = intdiv($s, LUMEN_V3_COLS); $col = $s % LUMEN_V3_COLS;
        for ($yy = 0; $yy < $S; $yy++) $out[] = substr($img, ($R * $S + $yy) * $W + $col * $S, $S);
    }
    return implode('', $out);
}

/**
 * Lossless WebP of a greyscale image. GD builds a truecolor image from a level-0 PNG of
 * the bytes (a palette of the 256 greys, converted: R = G = B, opaque — libwebp's "exact"
 * handling of transparent pixels never applies), then encodes with IMG_WEBP_LOSSLESS
 * (PHP ≥ 8.1). The capability probe checks the round trip on this host's libwebp.
 */
function lumen_v3_webp_encode(string $grey, int $w, int $h): string {
    if (!defined('IMG_WEBP_LOSSLESS') || !function_exists('imagewebp')) throw new RuntimeException('no lossless WebP encoder');
    if (strlen($grey) !== $w * $h) throw new InvalidArgumentException('webp_encode: size');
    $rows = [];
    for ($y = 0; $y < $h; $y++) $rows[] = substr($grey, $y * $w, $w);
    $png = LUMEN_MIG_PNG_SIG
        . lumen_mig_png_chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 0, 0, 0, 0))
        . lumen_mig_png_chunk('IDAT', gzcompress("\0" . implode("\0", $rows), 0))
        . lumen_mig_png_chunk('IEND', '');
    unset($rows);
    $im = @imagecreatefromstring($png);
    unset($png);
    if (!$im) throw new RuntimeException('GD cannot read the greyscale image');
    try {
        if (!imageistruecolor($im) && !imagepalettetotruecolor($im)) throw new RuntimeException('GD truecolor conversion failed');
        imagealphablending($im, false);
        ob_start();
        $ok = @imagewebp($im, null, IMG_WEBP_LOSSLESS);
        $bytes = (string)ob_get_clean();
    } finally {
        imagedestroy($im);
    }
    if (!$ok || strncmp($bytes, 'RIFF', 4) !== 0) throw new RuntimeException('imagewebp failed');
    return $bytes;
}

/**
 * The greyscale bytes (red component) of a WebP image of exactly $w × $h, or a
 * RuntimeException (wrong size, translucent pixel, undecodable).
 */
function lumen_v3_webp_decode(string $bytes, int $w, int $h): string {
    $im = lumen_mig_gd_open($bytes);
    if ($im === null) throw new RuntimeException('WebP does not decode');
    try {
        if (imagesx($im) !== $w || imagesy($im) !== $h) throw new RuntimeException('WebP is ' . imagesx($im) . '×' . imagesy($im) . ", expected {$w}×{$h}");
        return lumen_mig_gd_red($im, $w, $h);
    } finally {
        imagedestroy($im);
    }
}

function lumen_v3_encode_brick(string $brick): string {
    return lumen_v3_webp_encode(lumen_v3_mosaic($brick), LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H);
}

function lumen_v3_decode_brick(string $bytes): string {
    return lumen_v3_unmosaic(lumen_v3_webp_decode($bytes, LUMEN_V3_MOSAIC_W, LUMEN_V3_MOSAIC_H));
}

/** Is the 64³ interior of a 66³ brick all zero? (ESS, SPEC §13.1: kept iff a voxel ≥ 1.) */
function lumen_v3_interior_zero(string $brick): bool {
    $S = LUMEN_V3_SLICE;
    for ($z = 1; $z <= 64; $z++) {
        for ($y = 1; $y <= 64; $y++) {
            if (strspn($brick, "\0", ($z * $S + $y) * $S + 1, 64) !== 64) return false;
        }
    }
    return true;
}

/**
 * Lossless WebP encode→decode exact on this host (SPEC §13.5). A ramp with every byte
 * value, odd sizes, and the values a lossy or "near-lossless" path would bend.
 */
function lumen_v3_webp_lossless_ok(): bool {
    static $ok = null;
    if ($ok !== null) return $ok;
    $ok = false;
    if (!defined('IMG_WEBP_LOSSLESS') || !function_exists('imagewebp') || !function_exists('imagecreatefromstring')) return $ok;
    try {
        $w = 37; $h = 11; $px = '';
        for ($i = 0; $i < $w * $h; $i++) $px .= chr(($i * 97 + 13 + intdiv($i, 7) * 31) & 0xFF);
        $px[0] = "\0"; $px[1] = "\xFF"; $px[2] = "\x01"; $px[3] = "\xFE";
        $ok = lumen_v3_webp_decode(lumen_v3_webp_encode($px, $w, $h), $w, $h) === $px;
    } catch (Throwable $e) {
        $ok = false;
    }
    return $ok;
}

// ── Format 4: packs and index.bin ────────────────────────────────────────────

function lumen_v3_pack_rel(int $level, int $channel, int $pack): string {
    return sprintf('l%d/c%d/p%05d.bin', $level, $channel, $pack);
}

/** Flat brick indices of a level grid [gx, gy, gz], one list per 4×4×4 super-block (SBZ, SBY, SBX), bricks inside (bz, by, bx). */
function lumen_v3_superblock_order(array $grid): array {
    [$gx, $gy, $gz] = $grid;
    $out = [];
    for ($sz = 0; $sz < $gz; $sz += 4) for ($sy = 0; $sy < $gy; $sy += 4) for ($sx = 0; $sx < $gx; $sx += 4) {
        $b = [];
        for ($bz = $sz; $bz < min($gz, $sz + 4); $bz++) for ($by = $sy; $by < min($gy, $sy + 4); $by++) for ($bx = $sx; $bx < min($gx, $sx + 4); $bx++) {
            $b[] = ($bz * $gy + $by) * $gx + $bx;
        }
        $out[] = $b;
    }
    return $out;
}

/**
 * Pack layout of one (level, channel) (SPEC §13.4; twin of dataset_migrations.pack_layout).
 * $lengths: stored sizes in brick order (bz, by, bx), 0 = absent. Bricks are written
 * super-block by super-block, absent ones skipped; a pack holds whole super-blocks (a new
 * pack before a super-block that would take a non-empty pack past 64 bricks or 16 MiB);
 * a super-block over a limit on its own is split brick by brick (a new pack before a
 * brick that would take a non-empty pack past a limit). Returns [layout, npacks, order]:
 * layout[i] = [pack, offset, length] ([0, 0, 0] absent), order = the present bricks in
 * the order the packs concatenate them.
 */
function lumen_v3_pack_layout(array $lengths, array $grid, ?int $maxBricks = null, ?int $maxBytes = null): array {
    $maxBricks = $maxBricks ?? LUMEN_V3_PACK_MAX_BRICKS;
    $maxBytes = $maxBytes ?? LUMEN_V3_PACK_MAX_BYTES;
    if ($grid[0] * $grid[1] * $grid[2] !== count($lengths)) throw new InvalidArgumentException('pack_layout: lengths do not match the grid');
    $layout = array_fill(0, count($lengths), [0, 0, 0]);
    $order = [];
    $pack = 0; $count = 0; $size = 0;
    foreach (lumen_v3_superblock_order($grid) as $block) {
        $members = [];
        $b = 0;
        foreach ($block as $i) if ($lengths[$i] > 0) { $members[] = $i; $b += $lengths[$i]; }
        if (!$members) continue;
        $n = count($members);
        if ($count && ($count + $n > $maxBricks || $size + $b > $maxBytes)) { $pack++; $count = 0; $size = 0; }
        $split = $n > $maxBricks || $b > $maxBytes;
        foreach ($members as $i) {
            $ln = $lengths[$i];
            if ($split && $count && ($count >= $maxBricks || $size + $ln > $maxBytes)) { $pack++; $count = 0; $size = 0; }
            $layout[$i] = [$pack, $size, $ln];
            $order[] = $i;
            $count++;
            $size += $ln;
        }
    }
    return [$layout, $order ? $pack + 1 : 0, $order];
}

/** index.bin header + level table. $levels: [[gx, gy, gz, packCount]]. Entries follow (lumen_v3_index_entry). */
function lumen_v3_index_head(array $levels, int $channels): string {
    if (count($levels) < 1 || count($levels) > 0xFFFF || $channels < 1 || $channels > 0xFFFF) throw new InvalidArgumentException('index: level or channel count');
    $s = LUMEN_V3_INDEX_MAGIC . pack('vvvv', LUMEN_V3_INDEX_VERSION, count($levels), $channels, 0);
    foreach ($levels as [$gx, $gy, $gz, $packs]) $s .= pack('VVVV', $gx, $gy, $gz, $packs);
    return $s;
}

function lumen_v3_index_entry(int $pack, int $offset, int $length): string {
    return pack('vVV', $pack, $offset, $length);
}

/** {levels: [[gx,gy,gz,packs]], channels, entriesAt: [byte offset of each level's entries]} of an index.bin. */
function lumen_v3_parse_index(string $data): array {
    if (strlen($data) < LUMEN_V3_INDEX_HEADER || substr($data, 0, 4) !== LUMEN_V3_INDEX_MAGIC) throw new InvalidArgumentException('index.bin: bad magic');
    $h = unpack('vver/vlevels/vchannels/vres', substr($data, 4, 8));
    if ($h['ver'] !== LUMEN_V3_INDEX_VERSION) throw new InvalidArgumentException('index.bin: version');
    $pos = LUMEN_V3_INDEX_HEADER; $levels = [];
    for ($k = 0; $k < $h['levels']; $k++) {
        if ($pos + 16 > strlen($data)) throw new InvalidArgumentException('index.bin: truncated');
        $levels[] = array_values(unpack('V4', substr($data, $pos, 16)));
        $pos += 16;
    }
    $at = [];
    foreach ($levels as [$gx, $gy, $gz]) {
        $at[] = $pos;
        $pos += $h['channels'] * $gx * $gy * $gz * LUMEN_V3_INDEX_ENTRY;
    }
    if ($pos !== strlen($data)) throw new InvalidArgumentException('index.bin: size');
    return ['levels' => $levels, 'channels' => $h['channels'], 'entriesAt' => $at];
}

/** [pack, offset, length] of brick (c, bx, by, bz) of level k from a parsed index.bin. */
function lumen_v3_index_lookup(string $data, array $idx, int $k, int $c, int $bx, int $by, int $bz): array {
    [$gx, $gy, $gz] = $idx['levels'][$k];
    $i = ($c * $gz * $gy * $gx) + ($bz * $gy + $by) * $gx + $bx;
    return array_values(unpack('vp/Vo/Vl', substr($data, $idx['entriesAt'][$k] + $i * LUMEN_V3_INDEX_ENTRY, LUMEN_V3_INDEX_ENTRY)));
}

// ── Format 4: one work unit (a 4×4×4 super-block of one level and channel) ───

/**
 * Clamped source index list of the 2·o voxels feeding o output voxels starting at
 * output index $lo: [2·lo, 2·lo + 2·o) ∩ [0, n) — the caller replicates the one voxel a
 * ceil-halved odd edge lacks (lumen_v3_reduce_plane).
 */
function lumen_v3_src_span(int $lo, int $o, int $n): array {
    $a = 2 * $lo;
    return [$a, min($a + 2 * $o, $n)];
}

/** Number of octants (sub-units) of an m004 super-block. */
const LUMEN_V3_PARTS = 8;

/**
 * Brick range [b0, b1) per axis (x, y, z) of super-block B (4×4×4 bricks) or, for
 * $part ∈ [0, 8), of its octant: axis bit x = part & 1, y = part >> 1 & 1, z = part >> 2 & 1.
 * Not clipped to the grid (the callers clip).
 */
function lumen_v3_part_bricks(array $B, int $part = -1): array {
    $b0 = []; $b1 = [];
    for ($a = 0; $a < 3; $a++) {
        if ($part < 0) {
            $b0[$a] = 4 * $B[$a]; $b1[$a] = 4 * $B[$a] + 4;
        } else {
            $b0[$a] = 4 * $B[$a] + 2 * (($part >> $a) & 1); $b1[$a] = $b0[$a] + 2;
        }
    }
    return [$b0, $b1];
}

/**
 * Compute the stored images of the bricks of unit (L, c, BZ, BY, BX) — SPEC §13.2/§13.5.
 *
 * $ladder: lumen_v3_ladder output. $plane(z, x0, x1, y0, y1): the source level's voxels
 * of plane z on [x0, x1) × [y0, y1) (indices inside the source level, row-major) — the
 * source is the native volume itself for L = 0, level L − 1 otherwise, so the unit's
 * region S is the identity of it (L = 0) or its 2×2(×2) mean (L ≥ 1).
 *
 * S covers the unit's interior bricks plus the 1-voxel apron, clipped to the level:
 * [max(0, 256·B − 1), min(N, 256·B + 257)) per axis. Each 66³ brick is then cut out of
 * S with clamp-to-edge outside the level; a brick whose 64³ interior is all zero is not
 * stored (ESS). Peak memory: S (≤ 258³ ≈ 17 MB) + one brick and its mosaic.
 *
 * $part ∈ [0, 8): only the bricks of that octant (2×2×2 bricks) of the super-block, S
 * then covers the octant + apron (≤ 130³). Every brick depends only on the level's
 * voxels, so the 8 octants together are exactly the whole unit — what a slow host's
 * server executor runs instead of one long unit (lumen_mig_unit_run).
 *
 * @return array [ [ "bz.by.bx" => webp bytes ] in brick order (bz, by, bx), stats ]
 */
function lumen_v3_build_unit(array $ladder, int $L, int $BZ, int $BY, int $BX, callable $plane, ?callable $tick = null, int $part = -1): array {
    $dims = $ladder[$L]['dimensions'];
    $N = [$dims['x'], $dims['y'], $dims['z']];
    [$b0, $b1] = lumen_v3_part_bricks([$BX, $BY, $BZ], $part);
    $lo = []; $hi = [];
    for ($a = 0; $a < 3; $a++) {
        $lo[$a] = max(0, 64 * $b0[$a] - 1);
        $hi[$a] = min($N[$a], 64 * $b1[$a] + 1);
        if ($lo[$a] >= $hi[$a]) return [[], ['stored' => 0, 'skipped' => 0]];
    }
    $Sx = $hi[0] - $lo[0]; $Sy = $hi[1] - $lo[1];
    $S = [];                                                     // z - lo[2] => plane Sx × Sy
    if ($L === 0) {
        for ($z = $lo[2]; $z < $hi[2]; $z++) {
            $S[] = $plane($z, $lo[0], $hi[0], $lo[1], $hi[1]);
            if ($tick) $tick();
        }
    } else {
        $src = $ladder[$L - 1]['dimensions'];
        $halve = (bool)$ladder[$L]['halveZ'];
        [$sx0, $sx1] = lumen_v3_src_span($lo[0], $Sx, $src['x']);
        [$sy0, $sy1] = lumen_v3_src_span($lo[1], $Sy, $src['y']);
        $sw = $sx1 - $sx0; $sh = $sy1 - $sy0;
        for ($z = $lo[2]; $z < $hi[2]; $z++) {
            if ($halve) {
                $p0 = $plane(2 * $z, $sx0, $sx1, $sy0, $sy1);
                $p1 = (2 * $z + 1 < $src['z']) ? $plane(2 * $z + 1, $sx0, $sx1, $sy0, $sy1) : $p0;
                $S[] = lumen_v3_reduce_plane([$p0, $p1], $sw, $sh, $Sx, $Sy);
                unset($p0, $p1);
            } else {
                $S[] = lumen_v3_reduce_plane([$plane($z, $sx0, $sx1, $sy0, $sy1)], $sw, $sh, $Sx, $Sy);
            }
            if ($tick) $tick();
        }
    }
    [$gx, $gy, $gz] = lumen_v3_grid($dims);
    $out = []; $skipped = 0;
    $zero64 = str_repeat("\0", 64);
    for ($bz = $b0[2]; $bz < min($b1[2], $gz); $bz++) {
        for ($by = $b0[1]; $by < min($b1[1], $gy); $by++) {
            for ($bx = $b0[0]; $bx < min($b1[0], $gx); $bx++) {
                // ESS on the interior's real voxels (the samples past the level's end replicate them).
                $ix0 = 64 * $bx - $lo[0]; $iw = min(64, $N[0] - 64 * $bx);
                $nonzero = false;
                for ($z = 64 * $bz; $z < min(64 * $bz + 64, $N[2]) && !$nonzero; $z++) {
                    $p = $S[$z - $lo[2]];
                    for ($y = 64 * $by; $y < min(64 * $by + 64, $N[1]); $y++) {
                        if (strspn($p, "\0", ($y - $lo[1]) * $Sx + $ix0, $iw) !== $iw) { $nonzero = true; break; }
                    }
                }
                if (!$nonzero) { $skipped++; continue; }
                // 66 clamped samples per axis: 64·b − 1 … 64·b + 64 within [0, N).
                $xa = 64 * $bx - 1; $xs = max(0, $xa); $xe = min($N[0], $xa + 66);
                $pre = $xs - $xa; $post = $xa + 66 - $xe;
                $rows = [];
                for ($k = 0; $k < 66; $k++) {
                    $p = $S[min($N[2] - 1, max(0, 64 * $bz - 1 + $k)) - $lo[2]];
                    for ($j = 0; $j < 66; $j++) {
                        $o = (min($N[1] - 1, max(0, 64 * $by - 1 + $j)) - $lo[1]) * $Sx;
                        $r = substr($p, $o + $xs - $lo[0], $xe - $xs);
                        if ($pre) $r = str_repeat($r[0], $pre) . $r;
                        if ($post) $r .= str_repeat($r[strlen($r) - 1], $post);
                        $rows[] = $r;
                    }
                }
                $out["$bz.$by.$bx"] = lumen_v3_encode_brick(implode('', $rows));
                unset($rows);
                if ($tick) $tick();
            }
        }
    }
    return [$out, ['stored' => count($out), 'skipped' => $skipped]];
}

/**
 * [width, height] of a LOSSLESS WebP — a simple VP8L file or an extended VP8X file whose
 * image is VP8L, not animated — read from the RIFF structure without decoding (twin of
 * dataset_migrations.webp_lossless_size). InvalidArgumentException for anything else,
 * a lossy VP8 included.
 */
function lumen_v3_webp_lossless_size(string $data): array {
    $n = strlen($data);
    if ($n < 20 || substr($data, 0, 4) !== 'RIFF' || substr($data, 8, 4) !== 'WEBP') throw new InvalidArgumentException('not a WebP (RIFF header)');
    $riff = unpack('V', substr($data, 4, 4))[1];
    if ($riff + 8 !== $n || $riff % 2) throw new InvalidArgumentException("RIFF size $riff does not match the file ($n bytes)");
    $pos = 12; $canvas = null; $image = null;
    while ($pos < $n) {
        if ($pos + 8 > $n) throw new InvalidArgumentException('truncated WebP chunk');
        $kind = substr($data, $pos, 4);
        $size = unpack('V', substr($data, $pos + 4, 4))[1];
        $body = $pos + 8;
        if ($body + $size > $n) throw new InvalidArgumentException('WebP chunk overruns the file');
        if ($kind === 'VP8X') {
            if ($pos !== 12 || $size < 10) throw new InvalidArgumentException('misplaced VP8X');
            if (ord($data[$body]) & 0x02) throw new InvalidArgumentException('animated WebP');
            $u24 = fn(int $p) => ord($data[$p]) | (ord($data[$p + 1]) << 8) | (ord($data[$p + 2]) << 16);
            $canvas = [1 + $u24($body + 4), 1 + $u24($body + 7)];
        } elseif ($kind === 'VP8 ') {
            throw new InvalidArgumentException('lossy WebP (VP8)');
        } elseif ($kind === 'ANIM' || $kind === 'ANMF') {
            throw new InvalidArgumentException('animated WebP');
        } elseif ($kind === 'VP8L') {
            if ($image !== null) throw new InvalidArgumentException('two image chunks');
            if ($size < 5 || ord($data[$body]) !== 0x2F) throw new InvalidArgumentException('bad VP8L signature');
            $bits = unpack('V', substr($data, $body + 1, 4))[1];
            if ($bits >> 29) throw new InvalidArgumentException('unknown VP8L version');
            $image = [($bits & 0x3FFF) + 1, (($bits >> 14) & 0x3FFF) + 1];
        }
        $pos = $body + $size + ($size & 1);
    }
    if ($image === null) throw new InvalidArgumentException('no VP8L image');
    if ($canvas !== null && $canvas !== $image) throw new InvalidArgumentException('VP8X canvas differs from the image');
    return $image;
}

// ── Format 3: one work unit (one layer, channel and 512² tile) ───────────────

/**
 * Entry i = [offset, length] of a plane/MIP pack header read from an open handle; the
 * header must describe the expected tree (magic, version, channels, tiles, z) and every
 * non-empty entry must point past the header. InvalidArgumentException otherwise.
 */
function lumen_mig_pack_entries($fh, string $magic, int $C, int $TX, int $TY, int $z): array {
    $hb = 16 + 12 * $C * $TY * $TX;
    if (@fseek($fh, 0) !== 0) throw new InvalidArgumentException('seek');
    $head = '';
    while (strlen($head) < $hb) {
        $chunk = fread($fh, $hb - strlen($head));
        if ($chunk === false || $chunk === '') break;
        $head .= $chunk;
    }
    if (strlen($head) !== $hb) throw new InvalidArgumentException('short header');
    $h = unpack('a4magic/vver/vc/vtx/vty/Vz', substr($head, 0, 16));
    if ($h['magic'] !== $magic || $h['ver'] !== 1 || $h['c'] !== $C || $h['tx'] !== $TX || $h['ty'] !== $TY || $h['z'] !== $z) {
        throw new InvalidArgumentException('header does not match the manifest');
    }
    $out = [];
    for ($i = 0, $n = $C * $TY * $TX; $i < $n; $i++) {
        $e = unpack('Poff/Vlen', substr($head, 16 + 12 * $i, 12));
        if ($e['len'] && ($e['off'] < $hb || $e['off'] < 0)) throw new InvalidArgumentException('tile inside the header');
        $out[] = [$e['off'], $e['len']];
    }
    return $out;
}

