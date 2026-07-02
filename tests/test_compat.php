<?php
/* Conformance run of api/_admin_lib.php:admin_compat_satisfies against the shared
   vector. Third twin of tests/test_compat.py / .js — all three must pass. */
declare(strict_types=1);
require_once __DIR__ . '/../api/_admin_lib.php';

$vector = json_decode(file_get_contents(__DIR__ . '/compat-vector.json'), true);
$failed = 0;
foreach ($vector['cases'] as $c) {
    [$ok] = admin_compat_satisfies($c['platform'], $c['decl']);
    if ($ok !== $c['expect']) {
        $failed++;
        fwrite(STDERR, sprintf("  FAIL platform=%s decl=%s -> %s (expected %s) [%s]\n",
            json_encode($c['platform']), json_encode($c['decl']),
            var_export($ok, true), var_export($c['expect'], true), $c['why']));
    }
}
if ($failed) { echo "$failed/" . count($vector['cases']) . " CASES FAILED\n"; exit(1); }
echo 'ALL ' . count($vector['cases']) . " COMPAT CASES PASSED (php)\n";
