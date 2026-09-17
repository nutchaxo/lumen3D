<?php
/* PHP twin of the boot-repair cases in tests/test_dataset_meta_identity.py.

   A metadata.json that lost its `type` / `id` (this host wrote the editor's
   payload verbatim until v1.54.1, and the editor never posts `type`) is put right
   by lumen_migrate_dataset_types() on the first request that runs it — the same
   entry point as the one-shot vocabulary migration, but the metadata pass is no
   longer gated on the legacy guard. Nobody has to re-save the dataset.

   datasets.php is loaded in library mode (LUMEN_DATASETS_LIB) from a COPY inside a
   throwaway web root, so data_web() — derived from the library's own location —
   is that root and the pass scans the fixtures, never the real DATA_WEB.
     php tests/test_repair_dataset_identity_php.php                                */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-repair-' . bin2hex(random_bytes(4));
@mkdir("$root/api", 0777, true);
@mkdir("$root/DATA_WEB/3d", 0777, true);
@mkdir("$root/uploads/state", 0777, true);
@mkdir("$root/config", 0777, true);
foreach (['_admin_lib.php', '_upload_lib.php', 'datasets.php'] as $f) copy(__DIR__ . "/../api/$f", "$root/api/$f");
define('LUMEN_DATASETS_LIB', true);
require_once "$root/api/datasets.php";

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
function put(string $dir, array $meta): void {
    @mkdir($dir, 0777, true);
    file_put_contents("$dir/metadata.json", json_encode($meta));
}
function stored(string $dir): array {
    return json_decode((string)file_get_contents("$dir/metadata.json"), true) ?: [];
}

$DATA_WEB = "$root/DATA_WEB";
check('the copied library resolves its own web root', data_web() === $DATA_WEB || realpath(data_web()) === realpath($DATA_WEB));

echo "a file that lost its identity\n";
put("$DATA_WEB/3d/demo", ['name' => 'Demo', 'stage' => 'E8.5', 'orientation' => ['x' => 0, 'y' => 0.7071, 'z' => 0, 'w' => 0.7071],
    'dimensions' => ['x' => 64, 'y' => 64, 'z' => 32, 'c' => 1], 'channels' => [['name' => 'DAPI']]]);
put("$DATA_WEB/3d/sound", ['id' => '3d/sound', 'type' => '3d', 'name' => 'Sound']);
$soundBefore = file_get_contents("$DATA_WEB/3d/sound/metadata.json");
check('this is not a legacy tree (the vocabulary migration itself has nothing to do)', lumen_migration_pending() === false);

lumen_migrate_dataset_types();
$m = stored("$DATA_WEB/3d/demo");
check('type is written back from the directory', ($m['type'] ?? null) === '3d');
check('id is written back as <type>/<folder>', ($m['id'] ?? null) === '3d/demo');
check('the rest of the file is untouched', ($m['name'] ?? null) === 'Demo' && abs(($m['orientation']['y'] ?? 0) - 0.7071) < 1e-9
    && ($m['dimensions']['z'] ?? null) === 32);
check('a sound file is not rewritten, not even reformatted', file_get_contents("$DATA_WEB/3d/sound/metadata.json") === $soundBefore);

echo "\nidempotent\n";
$demoAfter = file_get_contents("$DATA_WEB/3d/demo/metadata.json");
lumen_migration_metadata();   // the entry point runs once per process; the pass itself is what must be stable
check('a second pass changes nothing', file_get_contents("$DATA_WEB/3d/demo/metadata.json") === $demoAfter);

echo "\nthe editor can open it again\n";
$g = get_dataset_meta('3d/demo', "$DATA_WEB/3d/demo");
check('get returns the repaired identity', is_array($g) && $g['type'] === '3d' && $g['id'] === '3d/demo' && $g['folderName'] === 'demo');

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
