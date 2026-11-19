<?php
/**
 * Lumen3D — TIFF index API (twin of dev_server.py `/api/tiff-index`)
 * ==================================================================
 * Public, same-origin endpoint that answers the structural index of a TIFF sitting in the
 * ROOT of a dataset's download/ folder (the download bundle `tools/build_download_bundles.py`
 * writes): page geometry, codec, the byte run of every strip, and ImageJ's own metadata
 * (description, tags 50838 / 50839). The browser reads the pages itself with Range requests
 * (the Studio's "Open from library" TIFF source), so nothing here is a download.
 *
 *   GET /api/tiff-index.php?dataset=<type>/<folder>&file=<name>.tif
 *     → { "v": 1, "dataset", "file", "url", "size", "mtime", "bigtiff", "littleEndian",
 *         "width", "height", "bitsPerSample", ..., "pages", "uniform", "resolution",
 *         "imagej", ["pageInfo",] "strips": { "perPage", "offsets", "byteCounts" } }
 *   Errors: 400 invalid_dataset | invalid_file, 404 not_found (a hidden dataset too),
 *           422 not_tiff | malformed | too_many_pages | bigtiff_unsupported, 500 internal_error.
 *
 * PHP 7.4 syntax only (no match, ?->, str_contains, named arguments). The JSON written here is
 * byte-identical to the Python twin's (key order, number formatting): see
 * tests/test_tiff_index_php.php.
 */

// Guarded: an update copies files one by one, and a request landing mid-copy must not die on a missing prelude.
if (is_file(__DIR__ . '/_bootstrap.php')) require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/_admin_lib.php';   // LUMEN_DATASET_TYPES, lumen_str (no session, no auth)

const LUMEN_TIFF_VERSION    = 1;
const LUMEN_TIFF_MAX_PAGES  = 100000;
const LUMEN_TIFF_MAX_STRIPS = 1000000;
const LUMEN_TIFF_INFO_CAP   = 65536;
const LUMEN_TIFF_META_CAP   = 16777216;
const LUMEN_IJ_MAGIC        = 0x494A494A;
const LUMEN_IJ_INFO         = 0x696E666F;
const LUMEN_IJ_LABL         = 0x6C61626C;
const LUMEN_IJ_RANG         = 0x72616E67;
const LUMEN_IJ_LUTS         = 0x6C757473;

class LumenTiffError extends Exception {
    public $code_;
    public function __construct($code) {
        parent::__construct($code);
        $this->code_ = $code;
    }
}

function lumen_tiff_type_size($typ) {
    static $sizes = [1 => 1, 2 => 1, 3 => 2, 4 => 4, 5 => 8, 6 => 1, 7 => 1, 8 => 2, 9 => 4, 10 => 8, 11 => 4, 12 => 8, 16 => 8, 17 => 8, 18 => 8];
    return isset($sizes[$typ]) ? $sizes[$typ] : null;
}

/** An unsigned 16 / 32 / 64-bit integer at $o of $s in byte order $le (true = little endian). */
function lumen_tiff_u($s, $o, $n, $le) {
    if ($n === 2) { $r = unpack($le ? 'v' : 'n', substr($s, $o, 2)); return (int)$r[1]; }
    if ($n === 4) { $r = unpack($le ? 'V' : 'N', substr($s, $o, 4)); return (int)$r[1]; }
    $r = unpack($le ? 'P' : 'J', substr($s, $o, 8));
    return $r[1];
}

/** One integer of TIFF type $typ at $o (signed types sign-extended). */
function lumen_tiff_int($s, $o, $typ, $le) {
    switch ($typ) {
        case 1: return ord($s[$o]);
        case 6: $v = ord($s[$o]); return $v >= 128 ? $v - 256 : $v;
        case 3: return lumen_tiff_u($s, $o, 2, $le);
        case 8: $v = lumen_tiff_u($s, $o, 2, $le); return $v >= 32768 ? $v - 65536 : $v;
        case 4: return lumen_tiff_u($s, $o, 4, $le);
        case 9: $v = lumen_tiff_u($s, $o, 4, $le); return $v >= 2147483648 ? $v - 4294967296 : $v;
        default: return lumen_tiff_u($s, $o, 8, $le);   // 16, 17, 18
    }
}

/** An integral float is written as an integer (both twins agree on it), a non-finite one as null. */
function lumen_tiff_num($v) {
    if (is_float($v)) {
        if (is_nan($v) || is_infinite($v)) return null;
        if ($v == floor($v) && abs($v) < 9007199254740992.0) return (int)$v;
    }
    return $v;
}

function lumen_tiff_int_text($text) {
    return ($text !== null && preg_match('/\A-?[0-9]{1,15}\z/', $text)) ? (int)$text : null;
}

function lumen_tiff_float_text($text) {
    if ($text !== null && preg_match('/\A[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z/', $text)) {
        return lumen_tiff_num((float)$text);
    }
    return null;
}

function lumen_tiff_utf8($cp) {
    if ($cp < 0x80) return chr($cp);
    if ($cp < 0x800) return chr(0xC0 | ($cp >> 6)) . chr(0x80 | ($cp & 0x3F));
    if ($cp < 0x10000) return chr(0xE0 | ($cp >> 12)) . chr(0x80 | (($cp >> 6) & 0x3F)) . chr(0x80 | ($cp & 0x3F));
    return chr(0xF0 | ($cp >> 18)) . chr(0x80 | (($cp >> 12) & 0x3F)) . chr(0x80 | (($cp >> 6) & 0x3F)) . chr(0x80 | ($cp & 0x3F));
}

/** UTF-16 (in the file's byte order) to UTF-8; a lone surrogate becomes U+FFFD. */
function lumen_tiff_utf16($raw, $le) {
    $raw = substr($raw, 0, LUMEN_TIFF_INFO_CAP);
    $n = intdiv(strlen($raw), 2);
    $out = '';
    for ($i = 0; $i < $n; $i++) {
        $u = lumen_tiff_u($raw, $i * 2, 2, $le);
        if ($u >= 0xD800 && $u <= 0xDBFF && $i + 1 < $n) {
            $lo = lumen_tiff_u($raw, ($i + 1) * 2, 2, $le);
            if ($lo >= 0xDC00 && $lo <= 0xDFFF) {
                $out .= lumen_tiff_utf8(0x10000 + (($u - 0xD800) << 10) + ($lo - 0xDC00));
                $i++;
                continue;
            }
        }
        $out .= lumen_tiff_utf8(($u >= 0xD800 && $u <= 0xDFFF) ? 0xFFFD : $u);
    }
    return $out;
}

/** ImageJ's IJMetaData (tag 50839) cut by its byte counts (tag 50838). */
function lumen_tiff_ij_meta($meta, $counts, $le, $channels) {
    $out = ['ranges' => [], 'colors' => [], 'labels' => [], 'info' => null];
    if (!$counts || $meta === null || $meta === '') return $out;
    $hdr = $counts[0];
    if ($hdr < 12 || ($hdr - 4) % 8 !== 0 || $hdr > strlen($meta)) return $out;
    if (lumen_tiff_u($meta, 0, 4, $le) !== LUMEN_IJ_MAGIC) return $out;
    $blocks = [LUMEN_IJ_INFO => [], LUMEN_IJ_LABL => [], LUMEN_IJ_RANG => [], LUMEN_IJ_LUTS => []];
    $pos = $hdr;
    $bi = 1;
    $done = false;
    $entries = intdiv($hdr - 4, 8);
    for ($i = 0; $i < $entries && !$done; $i++) {
        $typ = lumen_tiff_u($meta, 4 + 8 * $i, 4, $le);
        $cnt = lumen_tiff_u($meta, 8 + 8 * $i, 4, $le);
        for ($k = 0; $k < $cnt; $k++) {
            if ($bi >= count($counts) || $pos + $counts[$bi] > strlen($meta)) { $done = true; break; }
            if (isset($blocks[$typ])) $blocks[$typ][] = substr($meta, $pos, $counts[$bi]);
            $pos += $counts[$bi];
            $bi++;
        }
    }
    if ($blocks[LUMEN_IJ_INFO]) $out['info'] = lumen_tiff_utf16($blocks[LUMEN_IJ_INFO][0], $le);
    foreach (array_slice($blocks[LUMEN_IJ_LABL], 0, $channels) as $b) $out['labels'][] = lumen_tiff_utf16($b, $le);
    if ($blocks[LUMEN_IJ_RANG]) {
        $b = $blocks[LUMEN_IJ_RANG][0];
        $n = intdiv(strlen($b), 8);
        for ($i = 0; $i < $n; $i++) {
            $d = unpack($le ? 'e' : 'E', substr($b, $i * 8, 8));
            $out['ranges'][] = lumen_tiff_num((float)$d[1]);
        }
    }
    foreach (array_slice($blocks[LUMEN_IJ_LUTS], 0, $channels) as $b) {
        if (strlen($b) >= 768) $out['colors'][] = sprintf('#%02x%02x%02x', ord($b[255]), ord($b[511]), ord($b[767]));
    }
    return $out;
}

/** The ImageJ block of the first page's description, or null for another writer. */
function lumen_tiff_imagej($text, $metaBytes, $counts, $le) {
    if (strncmp($text, 'ImageJ=', 7) !== 0) return null;
    $kv = [];
    foreach (explode("\n", $text) as $line) {
        $p = strpos($line, '=');
        if ($p !== false) $kv[trim(substr($line, 0, $p))] = trim(substr($line, $p + 1));
    }
    $get = function ($k) use ($kv) { return isset($kv[$k]) ? $kv[$k] : null; };
    $channels = lumen_tiff_int_text($get('channels'));
    if (!$channels) $channels = 1;
    $meta = lumen_tiff_ij_meta($metaBytes, $counts, $le, $channels);
    $slices = lumen_tiff_int_text($get('slices'));
    $frames = lumen_tiff_int_text($get('frames'));
    return [
        'version'    => $get('ImageJ'),
        'images'     => lumen_tiff_int_text($get('images')),
        'channels'   => $channels,
        'slices'     => $slices ? $slices : 1,
        'frames'     => $frames ? $frames : 1,
        'hyperstack' => $get('hyperstack') === 'true',
        'mode'       => $get('mode'),
        'unit'       => $get('unit'),
        'spacing'    => lumen_tiff_float_text($get('spacing')),
        'min'        => lumen_tiff_float_text($get('min')),
        'max'        => lumen_tiff_float_text($get('max')),
        'ranges'     => $meta['ranges'],
        'colors'     => $meta['colors'],
        'labels'     => $meta['labels'],
        'info'       => $meta['info'],
    ];
}

/** Walk the IFD chain of a TIFF / BigTIFF (seeks only: IFDs may sit between the pages' data). */
function lumen_tiff_parse($path) {
    $size = filesize($path);
    $f = @fopen($path, 'rb');
    if ($f === false || $size === false) throw new LumenTiffError('not_tiff');
    try {
        $head = fread($f, 16);
        if ($head === false || strlen($head) < 8 || ($head[0] . $head[1] !== 'II' && $head[0] . $head[1] !== 'MM')) throw new LumenTiffError('not_tiff');
        $le = $head[0] === 'I';
        $magic = lumen_tiff_u($head, 2, 2, $le);
        if ($magic === 42) {
            $big = false;
            $first = lumen_tiff_u($head, 4, 4, $le);
        } elseif ($magic === 43) {
            if (strlen($head) < 16 || lumen_tiff_u($head, 4, 2, $le) !== 8 || lumen_tiff_u($head, 6, 2, $le) !== 0) throw new LumenTiffError('malformed');
            if (PHP_INT_SIZE < 8) throw new LumenTiffError('bigtiff_unsupported');
            $big = true;
            $first = lumen_tiff_u($head, 8, 8, $le);
        } else {
            throw new LumenTiffError('not_tiff');
        }
        $inlineCap = $big ? 8 : 4;
        $entrySize = $big ? 20 : 12;
        $offLen = $big ? 8 : 4;

        $readAt = function ($off, $n) use ($f, $size) {
            if (!is_int($off) || $off < 8 || $n < 0 || $off + $n > $size) throw new LumenTiffError('malformed');
            if ($n === 0) return '';
            fseek($f, $off);
            $data = fread($f, $n);
            if ($data === false || strlen($data) !== $n) throw new LumenTiffError('malformed');
            return $data;
        };
        $valueBytes = function ($typ, $cnt, $raw) use ($inlineCap, $readAt, $offLen, $le) {
            $total = lumen_tiff_type_size($typ) * $cnt;
            if ($total <= $inlineCap) return substr($raw, 0, $total);
            return $readAt(lumen_tiff_u($raw, 0, $offLen, $le), $total);
        };
        $ints = function ($tags, $tag, $limit = 64) use ($valueBytes, $le) {
            if (!isset($tags[$tag])) return null;
            list($typ, $cnt, $raw) = $tags[$tag];
            if (!in_array($typ, [1, 3, 4, 6, 8, 9, 16, 17, 18], true) || $cnt < 1 || $cnt > $limit) throw new LumenTiffError('malformed');
            $data = $valueBytes($typ, $cnt, $raw);
            $unit = lumen_tiff_type_size($typ);
            $vals = [];
            for ($i = 0; $i < $cnt; $i++) $vals[] = lumen_tiff_int($data, $i * $unit, $typ, $le);
            return $vals;
        };
        $firstInt = function ($tags, $tag, $default) use ($ints) {
            $v = $ints($tags, $tag);
            return $v ? $v[0] : $default;
        };

        $pages = [];
        $offsets = [];
        $counts = [];
        $seen = [];
        $firstPage = [];
        $off = $first;
        while ($off) {
            if (isset($seen[$off]) || $off < 8 || $off >= $size) throw new LumenTiffError('malformed');
            $seen[$off] = true;
            if (count($pages) >= LUMEN_TIFF_MAX_PAGES) throw new LumenTiffError('too_many_pages');
            if ($big) {
                $n = lumen_tiff_u($readAt($off, 8), 0, 8, $le);
                if ($n > 65535) throw new LumenTiffError('malformed');
                $body = $readAt($off + 8, $n * $entrySize + 8);
            } else {
                $n = lumen_tiff_u($readAt($off, 2), 0, 2, $le);
                $body = $readAt($off + 2, $n * $entrySize + 4);
            }
            $tags = [];
            for ($i = 0; $i < $n; $i++) {
                $e = substr($body, $i * $entrySize, $entrySize);
                $tag = lumen_tiff_u($e, 0, 2, $le);
                $typ = lumen_tiff_u($e, 2, 2, $le);
                $cnt = $big ? lumen_tiff_u($e, 4, 8, $le) : lumen_tiff_u($e, 4, 4, $le);
                $raw = $big ? substr($e, 12, 8) : substr($e, 8, 4);
                if (lumen_tiff_type_size($typ) !== null) $tags[$tag] = [$typ, $cnt, $raw];
            }
            $next = lumen_tiff_u($body, $n * $entrySize, $offLen, $le);

            $tiled = isset($tags[322]);
            $width = $firstInt($tags, 256, null);
            $height = $firstInt($tags, 257, null);
            if (!$width || !$height) throw new LumenTiffError('malformed');
            $tagO = $tiled ? 324 : 273;
            $tagC = $tiled ? 325 : 279;
            if (!isset($tags[$tagO]) || !isset($tags[$tagC]) || $tags[$tagO][1] !== $tags[$tagC][1]) throw new LumenTiffError('malformed');
            if (count($offsets) + $tags[$tagO][1] > LUMEN_TIFF_MAX_STRIPS) throw new LumenTiffError('too_many_pages');
            $po = $ints($tags, $tagO, LUMEN_TIFF_MAX_STRIPS);
            $pc = $ints($tags, $tagC, LUMEN_TIFF_MAX_STRIPS);
            foreach ($po as $v) $offsets[] = $v;
            foreach ($pc as $v) $counts[] = $v;
            $pages[] = [
                'width' => $width, 'height' => $height, 'bitsPerSample' => $firstInt($tags, 258, 1),
                'compression' => $firstInt($tags, 259, 1), 'predictor' => $firstInt($tags, 317, 1),
                'strips' => count($po), 'samplesPerPixel' => $firstInt($tags, 277, 1),
                'sampleFormat' => $firstInt($tags, 339, 1), 'planarConfig' => $firstInt($tags, 284, 1),
                'photometric' => $firstInt($tags, 262, null), 'rowsPerStrip' => $firstInt($tags, 278, $height),
                'tiled' => $tiled,
            ];
            if (!$firstPage) {
                $text = '';
                if (isset($tags[270]) && $tags[270][0] === 2 && $tags[270][1] > 0 && $tags[270][1] <= 65536) {
                    $d = $valueBytes(2, $tags[270][1], $tags[270][2]);
                    $z = strpos($d, "\0");
                    $text = $z === false ? $d : substr($d, 0, $z);
                }
                $rational = function ($tag) use ($tags, $valueBytes, $le) {
                    if (!isset($tags[$tag]) || $tags[$tag][0] !== 5 || $tags[$tag][1] !== 1) return null;
                    $d = $valueBytes(5, 1, $tags[$tag][2]);
                    $num = lumen_tiff_u($d, 0, 4, $le);
                    $den = lumen_tiff_u($d, 4, 4, $le);
                    return $den === 0 ? null : $num / $den;
                };
                $rx = $rational(282);
                $ry = $rational(283);
                $firstPage['resolution'] = ($rx === null || $ry === null) ? null : [
                    'x' => lumen_tiff_num((float)sprintf('%.6g', $rx)),
                    'y' => lumen_tiff_num((float)sprintf('%.6g', $ry)),
                    'unit' => $firstInt($tags, 296, 2),
                ];
                $firstPage['desc'] = $text;
                $firstPage['metaCounts'] = null;
                $firstPage['meta'] = null;
                if (isset($tags[50838]) && isset($tags[50839]) && in_array($tags[50839][0], [1, 7], true)
                    && $tags[50839][1] >= 0 && $tags[50839][1] <= LUMEN_TIFF_META_CAP
                    && $tags[50838][1] >= 0 && $tags[50838][1] <= 100000) {      // a BigTIFF count of 2^63 or more unpacks negative: no tag
                    $firstPage['metaCounts'] = $ints($tags, 50838, 100000);
                    $firstPage['meta'] = $valueBytes($tags[50839][0], $tags[50839][1], $tags[50839][2]);
                }
            }
            $off = $next;
        }
    } finally {
        fclose($f);
    }
    if (!$pages) throw new LumenTiffError('malformed');
    return ['big' => $big, 'le' => $le, 'pages' => $pages, 'offsets' => $offsets, 'counts' => $counts, 'first' => $firstPage];
}

function lumen_tiff_b64($fmt, $values) {
    $out = '';
    foreach (array_chunk($values, 4096) as $chunk) {
        $out .= call_user_func_array('pack', array_merge([$fmt . '*'], $chunk));
    }
    return base64_encode($out);
}

function lumen_tiff_index($path, $dataset, $file) {
    $p = lumen_tiff_parse($path);
    $pages = $p['pages'];
    $first = $pages[0];
    $keys = ['width', 'height', 'bitsPerSample', 'compression', 'predictor', 'strips',
             'samplesPerPixel', 'sampleFormat', 'planarConfig', 'tiled'];
    $uniform = true;
    foreach ($pages as $pg) {
        foreach ($keys as $k) if ($pg[$k] !== $first[$k]) { $uniform = false; break 2; }
    }
    $fp = $p['first'];
    $doc = [
        'v' => LUMEN_TIFF_VERSION, 'dataset' => $dataset, 'file' => $file,
        'url' => 'DATA_WEB/' . $dataset . '/download/' . $file,
        'size' => filesize($path), 'mtime' => (int)filemtime($path),
        'bigtiff' => $p['big'], 'littleEndian' => $p['le'],
        'width' => $first['width'], 'height' => $first['height'], 'bitsPerSample' => $first['bitsPerSample'],
        'sampleFormat' => $first['sampleFormat'], 'samplesPerPixel' => $first['samplesPerPixel'],
        'planarConfig' => $first['planarConfig'], 'photometric' => $first['photometric'],
        'compression' => $first['compression'], 'predictor' => $first['predictor'], 'tiled' => $first['tiled'],
        'rowsPerStrip' => $first['rowsPerStrip'], 'pages' => count($pages), 'uniform' => $uniform,
        'resolution' => $fp['resolution'],
        'imagej' => lumen_tiff_imagej($fp['desc'], $fp['meta'], $fp['metaCounts'], $p['le']),
    ];
    if ($uniform) {
        $doc['strips'] = ['perPage' => $first['strips'], 'offsets' => lumen_tiff_b64('e', $p['offsets']),
                          'byteCounts' => lumen_tiff_b64('V', $p['counts'])];
    } else {
        $info = [];
        $starts = [];
        $acc = 0;
        foreach ($pages as $pg) {
            $info[] = ['width' => $pg['width'], 'height' => $pg['height'], 'bitsPerSample' => $pg['bitsPerSample'],
                       'compression' => $pg['compression'], 'predictor' => $pg['predictor'], 'strips' => $pg['strips']];
            $starts[] = $acc;
            $acc += $pg['strips'];
        }
        $doc['pageInfo'] = $info;
        $doc['strips'] = ['perPage' => null, 'index' => lumen_tiff_b64('V', $starts),
                          'offsets' => lumen_tiff_b64('e', $p['offsets']), 'byteCounts' => lumen_tiff_b64('V', $p['counts'])];
    }
    return $doc;
}

function lumen_tiff_json($doc) {
    ini_set('serialize_precision', '-1');
    $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_INVALID_UTF8_SUBSTITUTE;
    $json = json_encode($doc, $flags);
    return $json === false ? '{"error":"internal_error"}' : $json;
}

function lumen_tiff_fail($status, $code) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('X-Content-Type-Options: nosniff');
    echo json_encode(['error' => $code]);
    exit;
}

// Same-origin only: no Access-Control-Allow-Origin (unlike downloads.php).
$ROOT          = dirname(__DIR__);
$DATA_WEB      = $ROOT . DIRECTORY_SEPARATOR . 'DATA_WEB';
$ALLOWED_TYPES = LUMEN_DATASET_TYPES;
$SAFE_FOLDER   = '/\A[A-Za-z0-9_][A-Za-z0-9._-]*\z/';

$datasetId = lumen_str($_GET['dataset'] ?? null) ?? '';
$name      = lumen_str($_GET['file'] ?? null) ?? '';

$parts = explode('/', $datasetId, 2);
if (count($parts) !== 2) lumen_tiff_fail(400, 'invalid_dataset');
$typeDir = trim($parts[0]);
$folder  = trim($parts[1]);
if (!in_array($typeDir, $ALLOWED_TYPES, true)) lumen_tiff_fail(400, 'invalid_dataset');
if ($folder === '.' || $folder === '..' || !preg_match($SAFE_FOLDER, $folder)) lumen_tiff_fail(400, 'invalid_dataset');
if (strpos($name, "\0") !== false || !preg_match('/\A[A-Za-z0-9_][A-Za-z0-9._ -]*\.(?:tif|tiff)\z/i', $name)) lumen_tiff_fail(400, 'invalid_file');

$dsDir   = $DATA_WEB . DIRECTORY_SEPARATOR . $typeDir . DIRECTORY_SEPARATOR . $folder;
$metaRaw = @file_get_contents($dsDir . DIRECTORY_SEPARATOR . 'metadata.json');
$metaDoc = is_string($metaRaw) ? json_decode($metaRaw, true) : null;
if (is_array($metaDoc) && !empty($metaDoc['hidden'])) lumen_tiff_fail(404, 'not_found');   // exactly like an unknown dataset

$rootReal = realpath($dsDir . DIRECTORY_SEPARATOR . 'download');
if ($rootReal === false || !is_dir($rootReal)) lumen_tiff_fail(404, 'not_found');
$real = realpath($rootReal . DIRECTORY_SEPARATOR . $name);
if ($real === false || dirname($real) !== $rootReal || !is_file($real)) lumen_tiff_fail(404, 'not_found');

$size  = filesize($real);
$mtime = (int)filemtime($real);
$etag  = '"' . $size . '-' . $mtime . '-v' . LUMEN_TIFF_VERSION . '"';
if (isset($_SERVER['HTTP_IF_NONE_MATCH']) && $_SERVER['HTTP_IF_NONE_MATCH'] === $etag) {
    http_response_code(304);
    header('ETag: ' . $etag);
    header('Cache-Control: no-cache');
    exit;
}
try {
    $doc = lumen_tiff_index($real, $typeDir . '/' . $folder, $name);
} catch (LumenTiffError $e) {
    lumen_tiff_fail(422, $e->code_);
}
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-cache');
header('ETag: ' . $etag);
echo lumen_tiff_json($doc);
