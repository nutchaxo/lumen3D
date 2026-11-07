<?php
/* The admin Stats tab names each dataset row from its metadata.json. Twin of
   dev_server.py _admin_stats, which reads the UNFILTERED dataset list: a dataset
   hidden from the public catalog (or never configured) still has views and
   downloads in api/stats.json and must still show its display name, not its id.
     php tests/test_admin_stats_names_php.php                                      */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-stats-names-' . bin2hex(random_bytes(4));
$dataWeb = "$root/DATA_WEB";
$priv = "$root/private";
mkdir($priv, 0777, true);
define('LUMEN_DATA_WEB', $dataWeb);
define('LUMEN_PRIVATE_DIR', $priv);
require_once __DIR__ . '/../api/_admin_lib.php';

function rm_tree(string $p): void {
    if (is_dir($p) && !is_link($p)) {
        foreach (array_diff((array)scandir($p), ['.', '..']) as $c) rm_tree("$p/$c");
        @rmdir($p);
    } else {
        @unlink($p);
    }
}
register_shutdown_function(function () use ($root) { rm_tree($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

function put_dataset(string $dataWeb, string $type, string $folder, array $meta): void {
    $dir = "$dataWeb/$type/$folder";
    mkdir($dir, 0777, true);
    file_put_contents("$dir/metadata.json", json_encode($meta));
}

put_dataset($dataWeb, '3d', 'E85-Hidden', ['name' => 'Hidden embryo', 'configured' => true, 'hidden' => true]);
put_dataset($dataWeb, '3d', 'E95-Draft', ['name' => 'Draft embryo']);
put_dataset($dataWeb, 'live', 'Public-TL', ['name' => 'Public timelapse', 'configured' => true]);

echo "dataset list used for the stats names\n";
$names = [];
foreach (lumen_catalog_rows() as $ds) $names[$ds['path']] = $ds['name'] ?? $ds['path'];
check('a hidden dataset is named', ($names['3d/E85-Hidden'] ?? null) === 'Hidden embryo');
check('an unconfigured dataset is named', ($names['3d/E95-Draft'] ?? null) === 'Draft embryo');
check('a public dataset is named', ($names['live/Public-TL'] ?? null) === 'Public timelapse');

$public = array_column(rebuild_catalog(), 'path');
check('the public catalog still leaves the hidden dataset out', !in_array('3d/E85-Hidden', $public, true));
check('the public catalog still leaves the unconfigured dataset out', !in_array('3d/E95-Draft', $public, true));

echo "api/admin.php stats action\n";
$src = (string)file_get_contents(__DIR__ . '/../api/admin.php');
$start = strpos($src, "case 'stats':");
$end = $start === false ? false : strpos($src, 'case ', $start + 1);
$block = ($start !== false && $end !== false) ? substr($src, $start, $end - $start) : '';
check('the stats case is found', $block !== '');
check('names come from every published dataset (lumen_catalog_rows)', strpos($block, 'lumen_catalog_rows()') !== false);
check('names do not come from the filtered public catalog', strpos($block, 'rebuild_catalog()') === false);

echo $fails ? "\n$fails FAILED\n" : "\nall passed\n";
exit($fails ? 1 : 0);
