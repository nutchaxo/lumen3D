<?php
/* Dataset formats 3 and 4 — PHP codecs (api/_migrations_formats.php), checked against
   naive per-voxel references written independently here:
     - per-voxel maximum of N planes (bit slicing) = max() of every byte;
     - 2×2(×2) integer mean rounded half up = (sum + n/2) // n over the voxels that exist,
       odd edges included;
     - 9×8 mosaic of a 66³ brick and its inverse; lossless WebP round trip exact;
     - png-gray8 decode of all five PNG filters (a decoder independent of our encoder);
     - pack assignment (64 bricks / 16 MiB), index.bin layout, WebP RIFF sniffing;
     - the unit builder (4×4×4 super-block, apron, clamp, ESS) against a naive 66³ cut.
   Run: php tests/test_v3_php_codecs.php   (GD with WebP; relaunches itself with -d extension=gd) */
declare(strict_types=1);

require __DIR__ . '/mig_php_fixture.inc.php';
mig_require_gd();
$tmp = mig_tmpdir('v3codec');
define('LUMEN_DATA_WEB', "$tmp/DATA_WEB");
define('LUMEN_UPLOADS_DIR', "$tmp/uploads");
define('LUMEN_PRIVATE_DIR', "$tmp/private");
@mkdir("$tmp/private", 0777, true);
require __DIR__ . '/../api/_migrations_lib.php';

$fails = 0; $n = 0;
function check(bool $ok, string $what): void {
    global $fails, $n;
    $n++;
    if (!$ok) { $fails++; echo "FAIL: $what\n"; }
}
function rnd_bytes(int $len, int $sparsity = 0): string {
    $s = '';
    for ($i = 0; $i < $len; $i++) $s .= chr(($sparsity && mt_rand(0, $sparsity)) ? 0 : mt_rand(0, 255));
    return $s;
}

mt_srand(20261005);

// ── maximum ──
foreach ([[1, 17], [2, 1], [5, 1000], [64, 4096]] as [$np, $len]) {
    $planes = [];
    for ($k = 0; $k < $np; $k++) $planes[] = rnd_bytes($len, $k % 3);
    $want = '';
    for ($i = 0; $i < $len; $i++) { $v = 0; foreach ($planes as $p) $v = max($v, ord($p[$i])); $want .= chr($v); }
    check(lumen_mig_bytes_max($planes) === $want, "bytes_max of $np planes × $len");
}
check(lumen_mig_bytes_max([str_repeat("\0", 9), str_repeat("\0", 9)]) === str_repeat("\0", 9), 'bytes_max of zeros');
check(lumen_mig_bytes_max(["\xFF\x00\x80", "\x7F\xFF\x81"]) === "\xFF\xFF\x81", 'bytes_max edge values');

// ── mean reduction ──
function naive_reduce(array $planes, int $sw, int $sh): string {
    $ow = intdiv($sw + 1, 2); $oh = intdiv($sh + 1, 2); $out = '';
    for ($y = 0; $y < $oh; $y++) for ($x = 0; $x < $ow; $x++) {
        $s = 0; $c = 0;
        foreach ($planes as $p) for ($yy = 2 * $y; $yy < min(2 * $y + 2, $sh); $yy++) for ($xx = 2 * $x; $xx < min(2 * $x + 2, $sw); $xx++) { $s += ord($p[$yy * $sw + $xx]); $c++; }
        $out .= chr(intdiv($s + intdiv($c, 2), $c));
    }
    return $out;
}
foreach ([[1, 1], [2, 2], [3, 5], [37, 23], [64, 64], [129, 3], [8, 1]] as [$sw, $sh]) {
    foreach ([1, 2] as $np) {
        $planes = [];
        for ($k = 0; $k < $np; $k++) $planes[] = rnd_bytes($sw * $sh);
        $ow = intdiv($sw + 1, 2); $oh = intdiv($sh + 1, 2);
        check(lumen_v3_reduce_plane($planes, $sw, $sh, $ow, $oh) === naive_reduce($planes, $sw, $sh), "reduce {$sw}×{$sh} ×$np");
    }
}
// The rounding is half UP, not to even: 1+2 → 2, 1+2+2+2 → 2, (0,0,0,1,1,1,1,0) → 1.
check(lumen_v3_reduce_plane(["\x01\x02"], 2, 1, 1, 1) === "\x02", 'half-up 2 voxels');
check(lumen_v3_reduce_plane(["\x01\x02\x02\x02"], 2, 2, 1, 1) === "\x02", 'half-up 4 voxels (7/4)');
check(lumen_v3_reduce_plane(["\x00\x00\x00\x01", "\x01\x01\x01\x00"], 2, 2, 1, 1) === "\x01", 'half-up 8 voxels (4/8)');
check(lumen_v3_reduce_plane(["\x00\x00\x00\x01", "\x01\x01\x00\x00"], 2, 2, 1, 1) === "\x00", '3/8 rounds down');
check(lumen_v3_reduce_plane([str_repeat("\xFF", 4), str_repeat("\xFF", 4)], 2, 2, 1, 1) === "\xFF", 'saturated block');

// ── ladder ──
$lad = lumen_v3_ladder(3789, 3789, 226, ['x' => 0.430366, 'y' => 0.430366, 'z' => 2.057106]);
check(count($lad) === 6 && $lad[1]['dimensions'] === ['x' => 1895, 'y' => 1895, 'z' => 226] && !$lad[1]['halveZ']
      && $lad[2]['dimensions']['z'] === 113 && $lad[2]['halveZ'] && $lad[5]['dimensions'] === ['x' => 119, 'y' => 119, 'z' => 15], 'ladder of a real acquisition');
check(count(lumen_v3_ladder(128, 100, 9, null)) === 1, 'no coarser level at ≤ 128');
check(count(lumen_v3_ladder(129, 1, 1, null)) === 2, 'one coarser level at 129');

// ── mosaic + WebP ──
$brick = rnd_bytes(66 ** 3, 2);
$mos = lumen_v3_mosaic($brick);
$ok = strlen($mos) === 594 * 528;
for ($s = 0; $s < 72 && $ok; $s++) {
    $col = $s % 9; $row = intdiv($s, 9);
    for ($y = 0; $y < 66; $y += 13) {
        $want = $s < 66 ? substr($brick, ($s * 66 + $y) * 66, 66) : str_repeat("\0", 66);
        if (substr($mos, ($row * 66 + $y) * 594 + $col * 66, 66) !== $want) { $ok = false; break; }
    }
}
check($ok, 'mosaic layout: slice s at column s%9, row s/9, 6 empty slots');
check(lumen_v3_unmosaic($mos) === $brick, 'unmosaic inverts mosaic');
check(lumen_v3_webp_lossless_ok(), 'host libwebp lossless round trip');
$webp = lumen_v3_encode_brick($brick);
check(lumen_v3_webp_lossless_size($webp) === [594, 528], 'encoded brick is a 594×528 VP8L');
check(lumen_v3_decode_brick($webp) === $brick, 'brick WebP round trip exact');
foreach (['RIFF' => 'not a WebP', substr($webp, 0, 30) => 'truncated'] as $bad => $why) {
    try { lumen_v3_webp_lossless_size($bad); check(false, "webp sniff accepts $why"); } catch (InvalidArgumentException $e) { check(true, ''); }
}
$im = imagecreatetruecolor(8, 8);
ob_start(); imagewebp($im, null, 80); $lossy = (string)ob_get_clean(); imagedestroy($im);
try { lumen_v3_webp_lossless_size($lossy); check(false, 'lossy WebP accepted'); } catch (InvalidArgumentException $e) { check(strpos($e->getMessage(), 'lossy') !== false, 'lossy WebP refused'); }

// ── PNG decode, five filters (encoded here with a deliberately different filter per row) ──
function png_filtered(string $px, int $w, int $h): string {
    $raw = ''; $prev = array_fill(0, $w, 0);
    for ($y = 0; $y < $h; $y++) {
        $f = $y % 5; $cur = array_values(unpack('C*', substr($px, $y * $w, $w)));
        $line = chr($f);
        for ($x = 0; $x < $w; $x++) {
            $a = $x ? $cur[$x - 1] : 0; $b = $prev[$x]; $c = $x ? $prev[$x - 1] : 0;
            $p = $a + $b - $c; $pa = abs($p - $a); $pb = abs($p - $b); $pc = abs($p - $c);
            $pred = [0, $a, $b, ($a + $b) >> 1, ($pa <= $pb && $pa <= $pc) ? $a : ($pb <= $pc ? $b : $c)][$f];
            $line .= chr(($cur[$x] - $pred) & 255);
        }
        $raw .= $line; $prev = $cur;
    }
    return LUMEN_MIG_PNG_SIG . lumen_mig_png_chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 0, 0, 0, 0))
         . lumen_mig_png_chunk('IDAT', gzcompress($raw, 9)) . lumen_mig_png_chunk('IEND', '');
}
$px = rnd_bytes(31 * 12);
check(lumen_mig_png_decode_gray(png_filtered($px, 31, 12), 31, 12) === $px, 'png decode, filters 0..4');
check(lumen_mig_png_decode_gray(lumen_mig_png_encode($px, 31, 12), 31, 12) === $px, 'png decode of our encoder');
try { lumen_mig_png_decode_gray(lumen_mig_png_encode($px, 31, 12), 30, 12); check(false, 'png size mismatch accepted'); } catch (InvalidArgumentException $e) { check(true, ''); }

// ── packs + index ──
// Super-block packing (§13.4): grid 8×1×1 = super-blocks {0..3}, {4..7}.
[$lay, $np, $ord] = lumen_v3_pack_layout([5, 0, 6, 7, 1, 1, 0, 1], [8, 1, 1], 4, 100);
check($np === 2 && $lay[0] === [0, 0, 5] && $lay[1] === [0, 0, 0] && $lay[3] === [0, 11, 7] && $lay[4] === [1, 0, 1] && $ord === [0, 2, 3, 4, 5, 7], 'a super-block that would pass 4 bricks opens a pack');
[$lay, $np] = lumen_v3_pack_layout([60, 60, 1, 1, 1, 0, 0, 0], [8, 1, 1], 64, 100);
check($np === 2 && $lay[0] === [0, 0, 60] && $lay[1] === [1, 0, 60] && $lay[2] === [1, 60, 1] && $lay[4] === [1, 62, 1], 'an oversized super-block splits brick by brick; the next one joins if it fits');
// Brick order of a 2-super-block grid in Y: SB (0,0,0) holds bz 0..3? here gz=1 → bricks by 0..3 then by 4..5.
check(lumen_v3_superblock_order([2, 6, 1]) === [[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11]], 'super-block order (SBZ, SBY, SBX), bricks (bz, by, bx)');
$head = lumen_v3_index_head([[2, 1, 1, 3], [1, 1, 1, 1]], 2);
$blob = $head;
foreach ([[[0, 0, 5], [1, 5, 6]], [[0, 0, 0], [2, 0, 9]], [[0, 0, 4]], [[0, 0, 0]]] as $ch) foreach ($ch as [$p, $o, $l]) $blob .= lumen_v3_index_entry($p, $o, $l);
$idx = lumen_v3_parse_index($blob);
check(strlen($blob) === 12 + 32 + 10 * 6 && substr($blob, 0, 12) === "LBIX\x01\x00\x02\x00\x02\x00\x00\x00", 'index.bin header bytes');
check($idx['levels'] === [[2, 1, 1, 3], [1, 1, 1, 1]] && lumen_v3_index_lookup($blob, $idx, 0, 1, 1, 0, 0) === [2, 0, 9]
      && lumen_v3_index_lookup($blob, $idx, 1, 0, 0, 0, 0) === [0, 0, 4], 'index.bin lookup');

// ── unit builder against a naive cut ──
$X = 150; $Y = 131; $Z = 70;
$vol = [];
for ($z = 0; $z < $Z; $z++) $vol[] = rnd_bytes($X * $Y, ($z % 3) * 4);
$vol[5] = str_repeat("\0", $X * $Y);
$ladder = lumen_v3_ladder($X, $Y, $Z, ['x' => 1, 'y' => 1, 'z' => 1]);
check(count($ladder) === 2 && $ladder[1]['halveZ'], 'test ladder');
$plane0 = fn($z, $x0, $x1, $y0, $y1) => implode('', array_map(fn($y) => substr($vol[$z], $y * $X + $x0, $x1 - $x0), range($y0, $y1 - 1)));
// Level 1 reference: naive reduce of full planes.
$d1 = $ladder[1]['dimensions'];
$vol1 = [];
for ($z = 0; $z < $d1['z']; $z++) {
    $pz = [$vol[2 * $z], $vol[min($Z - 1, 2 * $z + 1)]];
    if (2 * $z + 1 >= $Z) $pz = [$vol[2 * $z]];
    $vol1[] = naive_reduce($pz, $X, $Y);
}
foreach ([[0, $vol, $X, $Y, $Z], [1, $vol1, $d1['x'], $d1['y'], $d1['z']]] as [$L, $V, $LX, $LY, $LZ]) {
    [$gx, $gy, $gz] = lumen_v3_grid(['x' => $LX, 'y' => $LY, 'z' => $LZ]);
    $got = [];
    for ($BZ = 0; $BZ * 4 < $gz; $BZ++) for ($BY = 0; $BY * 4 < $gy; $BY++) for ($BX = 0; $BX * 4 < $gx; $BX++) {
        [$bricks] = lumen_v3_build_unit($ladder, $L, $BZ, $BY, $BX, $plane0);
        foreach ($bricks as $k => $w) $got[$k] = $w;
    }
    $ok = true; $kept = 0;
    for ($bz = 0; $bz < $gz; $bz++) for ($by = 0; $by < $gy; $by++) for ($bx = 0; $bx < $gx; $bx++) {
        $b = ''; $interior = false;
        for ($k = 0; $k < 66; $k++) for ($j = 0; $j < 66; $j++) for ($i = 0; $i < 66; $i++) {
            $zz = min($LZ - 1, max(0, 64 * $bz - 1 + $k)); $yy = min($LY - 1, max(0, 64 * $by - 1 + $j)); $xx = min($LX - 1, max(0, 64 * $bx - 1 + $i));
            $v = $V[$zz][$yy * $LX + $xx];
            $b .= $v;
            if ($v !== "\0" && $k >= 1 && $k <= 64 && $j >= 1 && $j <= 64 && $i >= 1 && $i <= 64) $interior = true;
        }
        $key = "$bz.$by.$bx";
        if (!$interior) { if (isset($got[$key])) $ok = false; continue; }
        $kept++;
        if (!isset($got[$key]) || lumen_v3_decode_brick($got[$key]) !== $b) { $ok = false; echo "  level $L brick $key differs\n"; }
    }
    check($ok && $kept > 0 && count($got) === $kept, "unit builder level $L: $kept bricks exact (apron, clamp, ESS)");
}

mig_rrmdir($tmp);
echo $fails ? "FAILED $fails/$n\n" : "OK $n checks\n";
exit($fails ? 1 : 0);
