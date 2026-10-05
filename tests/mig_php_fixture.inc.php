<?php
/* Shared fixture of the PHP dataset-migration tests (tests/test_mig_php_*.php).
   Builds small synthetic published datasets — lossless WebP grid mosaics packed
   exactly like preprocess/3-chunk_packer.py — whose every voxel is known, so the
   planes a migration produces can be checked pixel for pixel. Not a test itself
   (run_all only globs test_*.php). */
declare(strict_types=1);

/** Re-run this script with GD loaded when the CLI was started without it (Windows portable PHP). */
function mig_require_gd(): void {
    if (extension_loaded('gd') && function_exists('imagewebp')) return;
    if (getenv('LUMEN_MIG_GD_RELAUNCH') === '1') { echo "SKIP: the gd extension (with WebP) is not available\n"; exit(0); }
    $ext = dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext';
    $cmd = escapeshellarg(PHP_BINARY) . ' -d extension_dir=' . escapeshellarg($ext) . ' -d extension=gd '
         . escapeshellarg($_SERVER['argv'][0]);
    putenv('LUMEN_MIG_GD_RELAUNCH=1');
    passthru($cmd, $code);
    exit($code);
}

function mig_tmpdir(string $tag): string {
    $d = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'lumen-mig-' . $tag . '-' . bin2hex(random_bytes(4));
    mkdir($d, 0777, true);
    return str_replace('\\', '/', $d);
}

function mig_rrmdir(string $dir): void {
    if (!is_dir($dir)) return;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    @rmdir($dir);
}

/**
 * The synthetic volume: v(t, c, x, y, z) = (A[x] + B[y] + Z[z] + 101c + 53t) mod 256 with
 * pseudo-random A, B, Z (a transposed axis or a shifted plane cannot go unnoticed), and
 * 0 wherever the brick holding the voxel was dropped (ESS). The rows are precomputed
 * per offset k, so a row of the volume is a substring.
 */
final class MigVolume {
    public array $rowsByK = [];
    public array $B = []; public array $Zv = [];
    public function __construct(public int $X, public int $Y, public int $Z, public int $C, int $seed) {
        mt_srand($seed);
        $A = [];
        for ($x = 0; $x < $X; $x++) $A[] = mt_rand(0, 255);
        for ($y = 0; $y < $Y; $y++) $this->B[] = mt_rand(0, 255);
        for ($z = 0; $z < $Z; $z++) $this->Zv[] = mt_rand(0, 255);
        for ($k = 0; $k < 256; $k++) {
            $r = [];
            foreach ($A as $a) $r[] = ($a + $k) & 255;
            $this->rowsByK[$k] = pack('C*', ...$r);
        }
    }
    /** Is LOD0 brick (bx, by, bz) of channel c absent from brickToPack? */
    public function dropped(int $t, int $c, int $bx, int $by, int $bz): bool {
        if ($c === 1 && $bx >= 8 && $bz === 0) return true;          // a whole empty unit (tile column 1)
        return (($bx * 3 + $by * 5 + $bz * 7 + $c + $t) % 11) === 0;
    }
    /** The x-range [x0, x0+n) of row (y, z) of channel c at timepoint t, ESS applied. */
    public function row(int $t, int $c, int $y, int $z, int $x0, int $n): string {
        $k = ($this->B[$y] + $this->Zv[$z] + 101 * $c + 53 * $t) & 255;
        $out = '';
        $bz = intdiv($z, 64); $by = intdiv($y, 64);
        for ($x = $x0; $x < $x0 + $n; ) {
            $bx = intdiv($x, 64);
            $end = min($x0 + $n, ($bx + 1) * 64);
            $out .= $this->dropped($t, $c, $bx, $by, $bz) ? str_repeat("\0", $end - $x) : substr($this->rowsByK[$k], $x, $end - $x);
            $x = $end;
        }
        return $out;
    }
}

/** Greyscale PNG → GD truecolor → lossless WebP bytes (exact: checked by the tests). */
function mig_webp_lossless(string $grey, int $w, int $h): string {
    $png = lumen_mig_png_encode($grey, $w, $h);
    $im = imagecreatefromstring($png);
    if (!imageistruecolor($im)) imagepalettetotruecolor($im);
    ob_start();
    imagewebp($im, null, IMG_WEBP_LOSSLESS);
    $b = (string)ob_get_clean();
    imagedestroy($im);
    return $b;
}

/**
 * Write DATA_WEB/<type>/<folder>/ with metadata.json + bricks/manifest.json + packs.
 * $vols: [t => MigVolume] ('3d': [0 => vol]). Returns the dataset dir.
 */
function mig_build_dataset(string $dataWeb, string $type, string $folder, array $vols, array $extraMeta = []): string {
    $dir = "$dataWeb/$type/$folder";
    @mkdir("$dir/bricks", 0777, true);
    $first = reset($vols);
    $rows = [];
    $rootTransport = null; $rootLevels = null;
    foreach ($vols as $t => $vol) {
        $tname = $type === 'live' ? sprintf('t%03d', $t) : '';
        $tree = $tname === '' ? "$dir/bricks" : "$dir/bricks/$tname";
        $nx = intdiv($vol->X + 63, 64); $ny = intdiv($vol->Y + 63, 64); $nz = intdiv($vol->Z + 63, 64);
        $b2p = []; $chunks = [];
        for ($c = 0; $c < $vol->C; $c++) {
            @mkdir("$tree/lod0/c$c", 0777, true);
            $pack = "lod0/c$c/pack_00.bin";
            $fh = fopen("$tree/$pack", 'wb'); $off = 0;
            for ($bz = 0; $bz < $nz; $bz++) for ($by = 0; $by < $ny; $by++) for ($bx = 0; $bx < $nx; $bx++) {
                if ($vol->dropped($t, $c, $bx, $by, $bz)) continue;
                // Mosaic tile (zz mod 8, zz div 8) holds plane zz; padding beyond the volume is 0.
                $zero = str_repeat("\0", 64);
                $n = min(64, $vol->X - $bx * 64);
                $rowsOut = [];
                for ($ry = 0; $ry < 512; $ry++) {
                    $yy = $ry & 63; $y = $by * 64 + $yy;
                    $line = '';
                    for ($col = 0; $col < 8; $col++) {
                        $z = $bz * 64 + intdiv($ry, 64) * 8 + $col;
                        $line .= ($z < $vol->Z && $y < $vol->Y)
                            ? str_pad($vol->row($t, $c, $y, $z, $bx * 64, $n), 64, "\0") : $zero;
                    }
                    $rowsOut[] = $line;
                }
                $mosaic = implode('', $rowsOut);
                $webp = mig_webp_lossless($mosaic, 512, 512);
                fwrite($fh, $webp);
                $b2p[sprintf('lod0/c%d/x%03d_y%03d_z%03d.webp', $c, $bx, $by, $bz)] = ['url' => $pack, 'offset' => $off, 'length' => strlen($webp)];
                $off += strlen($webp);
            }
            fclose($fh);
        }
        for ($bz = 0; $bz < $nz; $bz++) for ($by = 0; $by < $ny; $by++) for ($bx = 0; $bx < $nx; $bx++) {
            $chunks[] = ['id' => "{$bz}_{$by}_{$bx}", 'nonEmpty' => true];
        }
        $levels = [['level' => 0, 'scale' => 1.0, 'dimensions' => ['x' => $vol->X, 'y' => $vol->Y, 'z' => $vol->Z], 'brickSize' => 64,
                    'gridSize' => ['x' => $nx, 'y' => $ny, 'z' => $nz], 'chunks' => $chunks]];
        $transport = ['mode' => 'packs', 'encoding' => 'webp-lossless', 'packSize' => 128, 'brickToPack' => $b2p];
        if ($rootTransport === null) { $rootTransport = $transport; $rootLevels = $levels; }
        if ($tname !== '') $rows[$tname] = ['path' => $tname, 'channels' => $vol->C, 'levels' => $levels, 'brickTransport' => $transport];
    }
    $man = ['version' => 2, 'schema' => 'iribhm-bricks-v2', 'dataset' => $folder, 'datasetType' => $type,
            'channels' => $first->C, 'brickSize' => 64, 'brickPacking' => ['mode' => 'grid', 'cols' => 8, 'rows' => 8],
            'levels' => $rootLevels, 'timepoints' => $rows ?: null, 'brickTransport' => $rootTransport];
    file_put_contents("$dir/bricks/manifest.json", json_encode($man));
    $meta = array_merge(['id' => "$type/$folder", 'type' => $type, 'name' => $folder, 'curatedNote' => 'keep me',
                         'dimensions' => ['x' => $first->X, 'y' => $first->Y, 'z' => $first->Z, 'c' => $first->C],
                         'channels' => array_map(fn($c) => ['name' => "ch$c"], range(0, $first->C - 1))], $extraMeta);
    file_put_contents("$dir/metadata.json", json_encode($meta, JSON_PRETTY_PRINT));
    return $dir;
}

/** Decode a greyscale 8-bit PNG (any filter) to [w, h, pixels]. Independent of the encoder. */
function mig_png_decode(string $png): array {
    if (strncmp($png, "\x89PNG\r\n\x1a\n", 8) !== 0) throw new RuntimeException('not a png');
    $p = 8; $idat = ''; $w = $h = 0; $types = [];
    while ($p < strlen($png)) {
        $len = unpack('N', substr($png, $p, 4))[1];
        $type = substr($png, $p + 4, 4);
        $data = substr($png, $p + 8, $len);
        if (pack('N', crc32($type . $data)) !== substr($png, $p + 8 + $len, 4)) throw new RuntimeException("bad crc $type");
        $types[] = $type;
        if ($type === 'IHDR') {
            $ih = unpack('Nw/Nh/Cbd/Cct/Ccm/Cfm/Cil', $data);
            if ($ih['bd'] !== 8 || $ih['ct'] !== 0 || $ih['il'] !== 0) throw new RuntimeException('not gray8');
            $w = $ih['w']; $h = $ih['h'];
        } elseif ($type === 'IDAT') $idat .= $data;
        $p += 12 + $len;
    }
    foreach ($types as $t) if (!in_array($t, ['IHDR', 'IDAT', 'IEND'], true)) throw new RuntimeException("unexpected chunk $t");
    $raw = gzuncompress($idat);
    $out = ''; $prev = array_fill(0, $w, 0);
    for ($y = 0; $y < $h; $y++) {
        $f = ord($raw[$y * ($w + 1)]);
        $line = array_values(unpack('C*', substr($raw, $y * ($w + 1) + 1, $w)));
        $cur = [];
        for ($x = 0; $x < $w; $x++) {
            $a = $x > 0 ? $cur[$x - 1] : 0; $b = $prev[$x]; $c = $x > 0 ? $prev[$x - 1] : 0;
            switch ($f) {
                case 0: $v = $line[$x]; break;
                case 1: $v = $line[$x] + $a; break;
                case 2: $v = $line[$x] + $b; break;
                case 3: $v = $line[$x] + intdiv($a + $b, 2); break;
                case 4: $pp = $a + $b - $c; $pa = abs($pp - $a); $pb = abs($pp - $b); $pc = abs($pp - $c);
                        $v = $line[$x] + (($pa <= $pb && $pa <= $pc) ? $a : ($pb <= $pc ? $b : $c)); break;
                default: throw new RuntimeException("bad filter $f");
            }
            $cur[] = $v & 255;
        }
        $out .= pack('C*', ...$cur);
        $prev = $cur;
    }
    return [$w, $h, $out];
}

/**
 * Check a whole planes/ tree against the volume. Returns a list of problems ([] = exact).
 * $planesDir = <ds>/planes or <ds>/planes/tNNN.
 */
function mig_verify_planes(string $planesDir, MigVolume $vol, int $t, string $expectSha): array {
    $errs = [];
    $man = json_decode((string)@file_get_contents("$planesDir/manifest.json"), true);
    if (!is_array($man)) return ["no manifest in $planesDir"];
    $TX = intdiv($vol->X + 511, 512); $TY = intdiv($vol->Y + 511, 512);
    $hb = 16 + 12 * $vol->C * $TX * $TY;
    $want = ['schema' => 'lumen-planes-v1', 'formatVersion' => 2, 'level' => 0,
             'dimensions' => ['x' => $vol->X, 'y' => $vol->Y, 'z' => $vol->Z], 'channels' => $vol->C, 'tileSize' => 512,
             'tiles' => ['x' => $TX, 'y' => $TY], 'codec' => 'png-gray8', 'packPattern' => 'z{z}.bin', 'headerBytes' => $hb];
    foreach ($want as $k => $v) if (($man[$k] ?? null) !== $v) $errs[] = "manifest $k";
    if (array_keys($man) !== ['schema', 'formatVersion', 'level', 'dimensions', 'channels', 'tileSize', 'tiles', 'codec', 'packPattern', 'headerBytes', 'source', 'producer', 'createdAt']) $errs[] = 'manifest key order';
    if (($man['source']['manifestSha256'] ?? null) !== $expectSha) $errs[] = 'manifest sha';
    for ($z = 0; $z < $vol->Z; $z++) {
        $pack = (string)@file_get_contents(sprintf('%s/z%05d.bin', $planesDir, $z));
        if (strlen($pack) < $hb) { $errs[] = "pack z$z short"; continue; }
        $h = unpack('a4magic/vver/vc/vtx/vty/Vz', substr($pack, 0, 16));
        if ($h['magic'] !== 'LPLN' || $h['ver'] !== 1 || $h['c'] !== $vol->C || $h['tx'] !== $TX || $h['ty'] !== $TY || $h['z'] !== $z) { $errs[] = "pack z$z header"; continue; }
        $i = 0; $expectOff = $hb;
        for ($c = 0; $c < $vol->C; $c++) for ($ty = 0; $ty < $TY; $ty++) for ($tx = 0; $tx < $TX; $tx++) {
            $e = unpack('Poff/Vlen', substr($pack, 16 + 12 * $i, 12)); $i++;
            $w = min(512, $vol->X - $tx * 512); $hh = min(512, $vol->Y - $ty * 512);
            $ref = '';
            for ($y = 0; $y < $hh; $y++) $ref .= $vol->row($t, $c, $ty * 512 + $y, $z, $tx * 512, $w);
            if ($e['len'] === 0) {
                if ($e['off'] !== 0) $errs[] = "z$z c$c y$ty x$tx zero tile with offset";
                if (strspn($ref, "\0") !== strlen($ref)) $errs[] = "z$z c$c y$ty x$tx missing tile";
                continue;
            }
            if ($e['off'] !== $expectOff) $errs[] = "z$z c$c y$ty x$tx not contiguous";
            $expectOff = $e['off'] + $e['len'];
            [$pw, $ph, $pix] = mig_png_decode(substr($pack, $e['off'], $e['len']));
            if ($pw !== $w || $ph !== $hh) { $errs[] = "z$z c$c y$ty x$tx size"; continue; }
            if ($pix !== $ref) $errs[] = "z$z c$c y$ty x$tx pixels";
        }
        if ($expectOff !== strlen($pack)) $errs[] = "pack z$z trailing bytes";
        if (count($errs) > 20) break;
    }
    return $errs;
}
