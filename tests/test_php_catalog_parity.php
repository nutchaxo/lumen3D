<?php
/* The PHP catalog (api/catalog.php → rebuild_catalog) is the SAME document as the
   Python one (dev_server.py _build_catalog): every metadata field, configured-or-
   thumbnailed and not hidden, newest date first then name, dot-folders skipped.
   Built from one fixture tree by both backends and compared; the Python half is
   skipped (not failed) when no interpreter can import dev_server.py. Also covers the
   signature cache and the `{}` round trip of a metadata save.
     php tests/test_php_catalog_parity.php                                          */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-catalog-' . bin2hex(random_bytes(4));
$dw   = $root . '/DATA_WEB';
foreach (['3d', '2d', 'live'] as $t) @mkdir("$dw/$t", 0777, true);
define('LUMEN_DATA_WEB', $dw);
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_DATASETS_LIB', true);
require_once __DIR__ . '/../api/datasets.php';

function rrm(string $d): void {
    if (!is_dir($d)) { @unlink($d); return; }
    foreach (scandir($d) ?: [] as $f) { if ($f !== '.' && $f !== '..') rrm("$d/$f"); }
    @rmdir($d);
}
register_shutdown_function(function () use ($root) { rrm($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}
function ds(string $dir, $meta, bool $thumb = false): void {
    @mkdir($dir, 0777, true);
    if ($meta !== null) file_put_contents("$dir/metadata.json", is_string($meta) ? $meta : json_encode($meta));
    if ($thumb) file_put_contents("$dir/thumbnail.webp", "RIFF\0\0\0\0WEBPVP8 ");
}

ds("$dw/3d/Alpha", '{"name":"Alpha","configured":true,"date":"2026-01-02","stage":"E8.5","stageNumeric":8.5,'
    . '"markers":["Egfl7"],"fileSize":123456,"orientationAxes":{"labels":{},"hidden":[]},'
    . '"volumeSources":[{"kind":"bricks","path":"DATA_WEB/3d/Alpha"}]}', true);
ds("$dw/3d/Beta", ['name' => 'Beta', 'date' => '2026-01-02'], true);                 // thumbnail only
ds("$dw/3d/Gamma", ['name' => 'Gamma']);                                           // neither → out
ds("$dw/3d/Hidden", ['name' => 'Hidden', 'configured' => true, 'hidden' => true], true);
ds("$dw/3d/Zeta", ['name' => '', 'configured' => true, 'date' => '2024-12-31']);   // falsy name → folder
ds("$dw/3d/.replaced-Alpha-1700000000", ['name' => 'Ghost', 'configured' => true], true);
ds("$dw/3d/NoMeta", null, true);
ds("$dw/3d/Broken", '{not json', true);
ds("$dw/3d/ListMeta", '[1,2,3]', true);
ds("$dw/2d/Photo", ['name' => 'Photo', '_adminConfigured' => true, 'date' => 'Unknown',
                    'pixelSizeUm' => ['x' => 1.5, 'y' => 1.5]], true);
ds("$dw/live/Clock", ['name' => 'Clock', 'configured' => true, 'date' => '2025-05-05',
                      'timeline' => ['frames' => 12]]);

echo "PHP catalog\n";
$cat = rebuild_catalog();
$ids = array_map(fn($d) => $d['id'], $cat);
check('listed: configured or thumbnailed, never hidden, no dot-folder, no broken file',
    $ids === ['3d/Beta', '3d/Alpha', 'live/Clock', '3d/Zeta', '2d/Photo']);   // same date: name descending
$alpha = $cat[1];
check('every metadata field is carried (date, markers, fileSize)', ($alpha['date'] ?? null) === '2026-01-02'
    && ($alpha['markers'] ?? null) === ['Egfl7'] && ($alpha['fileSize'] ?? null) === 123456);
check('identity comes from the directory', $alpha['path'] === '3d/Alpha' && $alpha['type'] === '3d' && $alpha['folderName'] === 'Alpha');
check('a falsy name falls back to the folder name', $cat[3]['name'] === 'Zeta');
check('a photograph without volumeSources gets []', $cat[4]['volumeSources'] === []);
check('a volume without volumeSources gets the web-stack default', ($cat[2]['volumeSources'][0]['kind'] ?? null) === 'webstack');
check('missing fields are present as null, like Python', array_key_exists('embryo', $alpha) && $alpha['embryo'] === null);

$body = lumen_catalog_json();
check('an empty map stays a map in the served JSON', strpos($body, '"labels": {}') !== false);
$again = lumen_catalog_json();
check('the second read is served from the cache', $again === $body && is_file($root . '/.catalog-cache.json'));
file_put_contents("$dw/3d/Beta/metadata.json", json_encode(['name' => 'Beta renamed', 'date' => '2026-01-02']));
check('a metadata change (size differs) rebuilds it', strpos(lumen_catalog_json(), 'Beta renamed') !== false);

echo "\nPHP ↔ Python parity\n";
$py = null;
foreach (['python', 'python3', 'py'] as $exe) {
    $code = 'import sys, json; sys.path.insert(0, sys.argv[1]); import dev_server as d; from pathlib import Path; '
          . 'd.DATA_WEB = Path(sys.argv[2]); d._CATALOG_CACHE.update(sig=None, data=None); '
          . 'sys.stdout.write(json.dumps(d._build_catalog(), ensure_ascii=False))';
    $cmd = escapeshellarg($exe) . ' -c ' . escapeshellarg($code) . ' ' . escapeshellarg(realpath(__DIR__ . '/..'))
         . ' ' . escapeshellarg($dw) . ' 2>' . (DIRECTORY_SEPARATOR === '\\' ? 'NUL' : '/dev/null');
    $out = shell_exec($cmd);
    if (is_string($out) && $out !== '' && is_array(json_decode($out, true))) { $py = json_decode($out, true); break; }
}
if ($py === null) {
    echo "  SKIP no Python interpreter could import dev_server.py\n";
} else {
    $php = json_decode(json_encode(rebuild_catalog()), true);
    check('same datasets, same order', array_map(fn($d) => $d['id'], $php) === array_map(fn($d) => $d['id'], $py));
    $same = true;
    foreach ($php as $i => $entry) {
        if (($py[$i] ?? null) != $entry) {           // == : value equality, key order aside
            $same = false;
            echo "    differs: " . $entry['id'] . "\n";
            echo "      php: " . json_encode($entry) . "\n      py:  " . json_encode($py[$i] ?? null) . "\n";
        }
    }
    check('every entry carries the same fields and values', $same);
}

echo "\nmetadata save round trip\n";
$demo = "$dw/3d/Alpha";
[$st] = save_dataset_meta('3d/Alpha', $demo, lumen_json_decode_doc('{"description":"x","extra":{}}'));
$raw = (string)file_get_contents("$demo/metadata.json");
check('save succeeds', $st === 200);
check('a stored {} is still {} after a PHP save', strpos($raw, '"labels": {}') !== false);
check('a posted {} is written as {}', strpos($raw, '"extra": {}') !== false);
check('no temp file is left beside it', !glob("$demo/.tmp-*"));

echo "\nconcurrent saves (lock)\n";
$lib = str_replace('\\', '/', (string)realpath(__DIR__ . '/../api/datasets.php'));
$child = $root . '/saver.php';
file_put_contents($child, "<?php\ndeclare(strict_types=1);\n"
    . "define('LUMEN_DATA_WEB', " . var_export($dw, true) . ");\n"
    . "define('LUMEN_PRIVATE_DIR', " . var_export($root, true) . ");\n"
    . "define('LUMEN_DATASETS_LIB', true);\nrequire " . var_export($lib, true) . ";\n"
    . "while (!is_file(\$argv[2])) usleep(2000);\n"
    . "save_dataset_meta('3d/Alpha', LUMEN_DATA_WEB . '/3d/Alpha', ['k' . \$argv[1] => (int)\$argv[1]]);\n");
$go = $root . '/go'; $procs = [];
for ($i = 0; $i < 12; $i++) {
    $procs[] = proc_open([PHP_BINARY, $child, (string)$i, $go], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $all[] = $pipes;
}
usleep(400000);
touch($go);
foreach ($procs as $k => $p) { stream_get_contents($all[$k][1]); fclose($all[$k][1]); fclose($all[$k][2]); proc_close($p); }
$m = json_decode((string)file_get_contents("$demo/metadata.json"), true);
$present = 0;
for ($i = 0; $i < 12; $i++) if (($m["k$i"] ?? null) === $i) $present++;
check("12 simultaneous saves of different keys: none lost ($present/12)", $present === 12);

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
