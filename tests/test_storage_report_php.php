<?php
/* PHP twin of tests/test_storage_report.py — asserts api/_admin_lib.php classifies
   every path exactly as dev_server.py _storage_bucket does, and that the live report
   of this install has the shape the Stockage tab reads.
     php tests/test_storage_report_php.php                                        */
declare(strict_types=1);

// The report caches its walk in the private dir: keep that out of the work tree.
$priv = sys_get_temp_dir() . '/lumen-storage-' . bin2hex(random_bytes(4));
mkdir($priv, 0777, true);
register_shutdown_function(function () use ($priv) { @unlink("$priv/storage-scan.json"); @rmdir($priv); });
define('LUMEN_PRIVATE_DIR', $priv);
require_once __DIR__ . '/../api/_admin_lib.php';

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

// The same table as tests/test_storage_report.py TestBucket.
$cases = [
    [['DATA_WEB', '3d', 'ds', 'thumbnail.webp'], ['data', '3d', '3d/ds', '(racine)']],
    [['DATA_WEB', '3d', 'ds', 'bricks', 'lod0', 'p.bin'], ['data', '3d', '3d/ds', 'bricks']],
    [['DATA_WEB', 'live', 'ds', 'download', 'a.zip'], ['data', 'live', 'live/ds', 'download']],
    [['DATA_WEB', '.htaccess'], ['data', 'autres', null, null]],
    [['DATA_WEB', '3d', 'stray.txt'], ['data', '3d', null, null]],
    [['uploads', 'staging', '3d', 'x', 'f'], ['uploads', 'staging', null, null]],
    [['uploads', 'trash', 'e', 'data'], ['uploads', 'trash', null, null]],
    [['uploads', '.htaccess'], ['uploads', 'autres', null, null]],
    [['js', 'modules', 'tools', 'x', 'index.js'], ['code', 'js/modules', null, null]],
    [['js', 'vendor', 'three.js'], ['code', 'js/vendor', null, null]],
    [['js', 'core', 'viewer.js'], ['code', 'js', null, null]],
    [['api', 'admin.php'], ['code', 'api', null, null]],
    [['README.md'], ['code', '(racine)', null, null]],
];
echo "storage_bucket\n";
foreach ($cases as [$rel, $want]) {
    check(implode('/', $rel), storage_bucket($rel) === $want);
}

echo "admin_storage_report (live install)\n";
$report = admin_storage_report(false);
foreach (['scannedAt', 'scanSeconds', 'trackedBytes', 'categories', 'datasets', 'disk', 'otherBytes', 'cached', 'ageSeconds', 'ttlSeconds'] as $k) {
    check("has $k", array_key_exists($k, $report));
}
check('disk fields', isset($report['disk']['totalBytes'], $report['disk']['usedBytes'], $report['disk']['freeBytes']));
check('tracked bytes add up', array_sum(array_column($report['categories'], 'bytes')) === $report['trackedBytes']);

echo $fails ? "\n$fails FAILED\n" : "\nall passed\n";
exit($fails ? 1 : 0);
