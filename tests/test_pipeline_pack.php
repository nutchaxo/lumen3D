<?php
/* PHP twin of tests/test_pipeline_pack.py — asserts admin_pipeline_local agrees
   with dev_server.py:_pipeline_local on which pack to serve when several are on
   disk, which is exactly what admin_update_apply_php's copy-over leaves behind.

   admin_root() is dirname(__DIR__) of the library, so the library is exercised
   from a COPY inside a throwaway web root whose assets/pipeline it then reads.
   Requires the zip extension:
     php -d extension_dir=<ext> -d extension=zip tests/test_pipeline_pack.php  */
declare(strict_types=1);

if (!class_exists('ZipArchive')) {
    fwrite(STDERR, "SKIP: ext-zip unavailable, cannot build fixture packs\n");
    exit(0);
}

$root = sys_get_temp_dir() . '/lumen-pack-' . bin2hex(random_bytes(4));
@mkdir($root . '/api', 0777, true);
@mkdir($root . '/assets/pipeline', 0777, true);
@mkdir($root . '/changelog', 0777, true);
copy(__DIR__ . '/../api/_admin_lib.php', $root . '/api/_admin_lib.php');
file_put_contents($root . '/changelog/changelog_1.42.0.md', 'x');
require_once $root . '/api/_admin_lib.php';

register_shutdown_function(function () use ($root) {
    foreach (['assets/pipeline', 'assets', 'changelog', 'api'] as $sub) {
        foreach (glob($root . '/' . $sub . '/*') ?: [] as $f) { @unlink($f); }
        @rmdir($root . '/' . $sub);
    }
    @rmdir($root);
});

$fails = 0;
function check($name, $cond) { global $fails; echo ($cond ? "  ok   " : "  FAIL ") . "$name\n"; if (!$cond) $fails++; }

/** Write one fixture pack: name => VERSION.json + an explicit mtime. */
function make_pack(string $dir, string $name, array $doc, int $mtime): void {
    $path = $dir . '/' . $name;
    $zip = new ZipArchive();
    $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
    $zip->addFromString(basename($name, '.zip') . '/VERSION.json', json_encode($doc));
    $zip->close();
    touch($path, $mtime);
}

/** Name chosen by admin_pipeline_local for a fresh set of packs. */
function pick(array $packs): ?string {
    $dir = admin_pipeline_dir();
    foreach (glob($dir . '/*.zip') ?: [] as $f) { unlink($f); }
    foreach ($packs as [$name, $doc, $mtime]) { make_pack($dir, $name, $doc, $mtime); }
    $got = admin_pipeline_local('leger');
    return $got === null ? null : basename($got);
}

const T0 = 1750000000;
$LEGACY  = ['lumen3d-pipeline-leger-1.41.0.zip',            // pre-v1.42.0: no platformVersion
            ['bundleVersion' => '1.41.0', 'preprocessVersion' => '0.14.1'], T0];
$CURRENT = ['lumen3d-pipeline-leger-0.15.0.zip',
            ['bundleVersion' => '0.15.0', 'preprocessVersion' => '0.15.0',
             'platformVersion' => '1.42.0'], T0 + 3600];

check('single pack is served whatever its naming',
    pick([$LEGACY]) === 'lumen3d-pipeline-leger-1.41.0.zip');
check('pack declaring THIS install wins over a higher-numbered leftover',
    pick([$LEGACY, $CURRENT]) === 'lumen3d-pipeline-leger-0.15.0.zip');
check('...even when it was written first',
    pick([$CURRENT, ['lumen3d-pipeline-leger-9.9.9.zip',
        ['bundleVersion' => '9.9.9', 'preprocessVersion' => '9.9.9',
         'platformVersion' => '1.40.0'], T0 + 7200]]) === 'lumen3d-pipeline-leger-0.15.0.zip');
check('neither matches this install -> most recently written',
    pick([['lumen3d-pipeline-leger-0.15.0.zip',
           ['bundleVersion' => '0.15.0', 'preprocessVersion' => '0.15.0',
            'platformVersion' => '1.41.1'], T0],
          ['lumen3d-pipeline-leger-0.16.0.zip',
           ['bundleVersion' => '0.16.0', 'preprocessVersion' => '0.16.0',
            'platformVersion' => '1.41.9'], T0 + 3600]]) === 'lumen3d-pipeline-leger-0.16.0.zip');
check('no pack at all -> null', pick([]) === null);

// The version the admin panel reports comes from inside the pack, not its name.
pick([$CURRENT]);
$v = admin_pipeline_pack_versions();
check('pack versions read from VERSION.json',
    $v['pack'] === '0.15.0' && $v['preprocess'] === '0.15.0' && $v['platform'] === '1.42.0');
check('preprocess version = the pack\'s', admin_preprocess_version() === '0.15.0');

if ($fails) { echo "\n$fails PIPELINE-PACK CHECKS FAILED (php)\n"; exit(1); }
echo "\nALL PIPELINE-PACK CHECKS PASSED (php)\n";
