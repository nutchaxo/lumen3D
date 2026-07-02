<?php
/* Parity: api/_admin_lib.php canonical plugin hash vs the shared vector.
   Third twin of tests/test_plugin_trust.{py,js} — all must agree. */
declare(strict_types=1);
require_once __DIR__ . '/../api/_admin_lib.php';

$v = json_decode(file_get_contents(__DIR__ . '/plugin-trust-vector.json'), true);
$fails = 0;

foreach ($v['files'] as $c) {
    $got = hash('sha256', base64_decode($c['b64']));
    if ($got !== $c['fileHash']) { $fails++; fwrite(STDERR, "  FAIL fileHash {$c['rel']}\n"); }
}
$fhs = [];
foreach ($v['files'] as $c) $fhs[$c['rel']] = $c['fileHash'];
if (admin_plugin_hash($fhs) !== $v['pluginHash']) { $fails++; fwrite(STDERR, "  FAIL pluginHash\n"); }
if (admin_plugin_hash([$v['singleFile']['rel'] => $v['singleFile']['fileHash']]) !== $v['singleFile']['pluginHash']) { $fails++; fwrite(STDERR, "  FAIL singleFile\n"); }

if ($fails) { echo "$fails PARITY FAILURES\n"; exit(1); }
echo 'ALL ' . (count($v['files']) + 2) . " PLUGIN-TRUST HASH CASES PASSED (php)\n";
