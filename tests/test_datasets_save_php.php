<?php
/* PHP twin of tests/test_dataset_meta_identity.py — the identity fields of a
   dataset (`id`, `type`, `folderName`) come from the directory it lives in, on
   every read and every write of api/datasets.php.

   The admin editor deliberately leaves `type` out of what it posts (the backend
   is the authority). datasets.php used to write the posted body VERBATIM, so one
   save from a PHP host dropped `type` from metadata.json; the next
   `action=get` then failed the editor's validateDatasetMeta ("invalid type")
   while the public pages — which derive the type from the directory — kept
   working. Python has always merged and re-asserted; PHP now does the same.

   datasets.php is loaded in library mode (LUMEN_DATASETS_LIB), so it defines its
   helpers without emitting headers, starting a session, or running the router.
     php tests/test_datasets_save_php.php                                        */
declare(strict_types=1);

define('LUMEN_DATASETS_LIB', true);
require_once __DIR__ . '/../api/datasets.php';

$root = sys_get_temp_dir() . '/lumen-save-' . bin2hex(random_bytes(4));
$ds   = $root . '/DATA_WEB/3d/demo';
@mkdir($ds, 0777, true);

function rrm(string $d): void {
    if (!is_dir($d)) return;
    foreach (scandir($d) ?: [] as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = "$d/$f";
        is_dir($p) ? rrm($p) : @unlink($p);
    }
    @rmdir($d);
}
register_shutdown_function(function () use ($root) { rrm($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}
function section(string $s): void { echo "\n$s\n"; }
function stored(string $ds): array {
    return json_decode((string)file_get_contents("$ds/metadata.json"), true) ?: [];
}

$pipeline = [
    'id' => '3d/demo', 'type' => '3d', 'name' => 'Demo', 'stage' => 'E8.5',
    'dimensions' => ['x' => 64, 'y' => 64, 'z' => 32, 'c' => 2],
    'channels' => [['name' => 'DAPI'], ['name' => 'GFP']],
    'volumeSources' => [['kind' => 'bricks', 'path' => 'DATA_WEB/3d/demo']],
    'orientationAxes' => ['labels' => ['A' => 'Head'], 'hidden' => ['D']],
];
file_put_contents("$ds/metadata.json", json_encode($pipeline));

section('save: what the editor posts (no `type`) keeps the identity');
$posted = $pipeline;
unset($posted['type']);                                  // the editor never posts it
$posted['name'] = 'Demo (oriented)';
$posted['orientation'] = ['x' => 0, 'y' => 0.7071, 'z' => 0, 'w' => 0.7071];
[$st, $pl] = save_dataset_meta('3d/demo', $ds, $posted);
$m = stored($ds);
check('save answers 200 / ok', $st === 200 && ($pl['ok'] ?? false) === true);
check('type is re-asserted from the directory', ($m['type'] ?? null) === '3d');
check('id is <type>/<folder>', ($m['id'] ?? null) === '3d/demo');
check('folderName is the folder', ($m['folderName'] ?? null) === 'demo');
check('the posted edit landed', ($m['name'] ?? null) === 'Demo (oriented)'
    && abs(($m['orientation']['y'] ?? 0) - 0.7071) < 1e-9);
check('configured + lastModified are the Python names', ($m['configured'] ?? false) === true
    && is_string($m['lastModified'] ?? null));

section('save: the sample-side flag round-trips as a boolean, false included');
[$st] = save_dataset_meta('3d/demo', $ds, ['upsideDown' => true]);
check('upside down is stored', (stored($ds)['upsideDown'] ?? null) === true);
[$st] = save_dataset_meta('3d/demo', $ds, ['upsideDown' => false]);
$m = stored($ds);
check('right side up is an explicit false, not an absent key (the editor always posts it)',
    array_key_exists('upsideDown', $m) && $m['upsideDown'] === false);

section('save: it is a MERGE, as on the Python dev server');
[$st] = save_dataset_meta('3d/demo', $ds, ['stage' => 'E9.0']);
$m = stored($ds);
check('a key the body does not carry survives', isset($m['volumeSources']) && isset($m['channels'])
    && ($m['orientation']['y'] ?? 0) > 0);
check('the carried key is updated', ($m['stage'] ?? null) === 'E9.0');
[$st] = save_dataset_meta('3d/demo', $ds, ['orientationAxes' => null]);
$m = stored($ds);
check('an explicit null erases (the editor clears a block this way)',
    array_key_exists('orientationAxes', $m) && $m['orientationAxes'] === null);
check('a posted type never wins over the directory',
    save_dataset_meta('3d/demo', $ds, ['type' => 'volume'])[0] === 200 && stored($ds)['type'] === '3d');

section('get: a file that lost its type still mounts');
$damaged = stored($ds);
unset($damaged['type'], $damaged['id'], $damaged['folderName']);   // what a verbatim save left behind
file_put_contents("$ds/metadata.json", json_encode($damaged));
$g = get_dataset_meta('3d/demo', $ds);
check('type comes back from the directory', is_array($g) && ($g['type'] ?? null) === '3d');
check('id and folderName too', is_array($g) && $g['id'] === '3d/demo' && $g['folderName'] === 'demo');
$damaged['type'] = 'volume';
file_put_contents("$ds/metadata.json", json_encode($damaged));
check('a wrong stored type is overridden', (get_dataset_meta('3d/demo', $ds)['type'] ?? null) === '3d');
check('a missing file is null, not an error', get_dataset_meta('3d/absent', "$root/DATA_WEB/3d/absent") === null);

section('list: configured under either spelling');
file_put_contents("$ds/metadata.json", json_encode(['name' => 'Demo', 'type' => '3d', 'configured' => true]));
@mkdir("$root/DATA_WEB/3d/legacy", 0777, true);
file_put_contents("$root/DATA_WEB/3d/legacy/metadata.json", json_encode(['name' => 'Legacy', 'type' => '3d', '_adminConfigured' => true]));
@mkdir("$root/DATA_WEB/3d/fresh", 0777, true);
file_put_contents("$root/DATA_WEB/3d/fresh/metadata.json", json_encode(['name' => 'Fresh', 'type' => '3d']));
$GLOBALS['DATA_WEB'] = "$root/DATA_WEB";
$rows = list_datasets();
$byName = array_column($rows, null, 'name');
check('`configured` (Python / new PHP) is read', ($byName['Demo']['configured'] ?? null) === true);
check('`_adminConfigured` (older PHP saves) is still read', ($byName['Legacy']['configured'] ?? null) === true);
check('an untouched dataset is not configured', ($byName['Fresh']['configured'] ?? null) === false);

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
