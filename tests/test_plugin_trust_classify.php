<?php
/* PHP twin of tests/test_plugin_trust_classify.py — asserts admin_classify_plugin
   agrees with dev_server.py:_classify_plugin on the key semantics: sandbox:true
   routes to the sandbox lane, dev-trust is loopback-gated, sandboxed-approval wins,
   hash-pinning + cap-subset void a stale approval. Uses the bundled fixtures. */
declare(strict_types=1);
require_once __DIR__ . '/../api/_admin_lib.php';

$_SERVER['REMOTE_ADDR'] = '127.0.0.1';  // loopback → dev-trust active (a .git checkout)
$SB  = modules_dir() . '/tools/screenshot-sandboxed';  // sandbox:true
$REG = modules_dir() . '/tools/screenshot';            // regular in-page
$hSB = admin_plugin_hash(admin_plugin_file_hashes($SB));
$declared = admin_plugin_declared_caps($SB);
$fails = 0;
function check($name, $cond) { global $fails; echo ($cond ? "  ok   " : "  FAIL ") . "$name\n"; if (!$cond) $fails++; }

check('dev + sandbox:true -> sandboxed (author lane)',
    admin_classify_plugin('tools/screenshot-sandboxed', $SB, [], null)['tier'] === 'sandboxed');
check('dev + regular -> dev (in-page)',
    admin_classify_plugin('tools/screenshot', $REG, [], null)['tier'] === 'dev');

$_SERVER['REMOTE_ADDR'] = '192.168.1.9';  // LAN client → NO dev-trust
check('LAN + regular -> untrusted (loopback gate)',
    admin_classify_plugin('tools/screenshot', $REG, [], null)['tier'] === 'untrusted');
check('LAN + sandboxed approval (hash ok) -> sandboxed (wins)',
    admin_classify_plugin('tools/screenshot-sandboxed', $SB,
        [['path' => 'tools/screenshot-sandboxed', 'sha256' => $hSB, 'mode' => 'sandboxed', 'caps' => $declared]], null)['tier'] === 'sandboxed');
check('LAN + hash drift -> untrusted',
    admin_classify_plugin('tools/screenshot-sandboxed', $SB,
        [['path' => 'tools/screenshot-sandboxed', 'sha256' => str_repeat('0', 64), 'mode' => 'sandboxed', 'caps' => $declared]], null)['tier'] === 'untrusted');
check('LAN + under-granted caps -> untrusted',
    admin_classify_plugin('tools/screenshot-sandboxed', $SB,
        [['path' => 'tools/screenshot-sandboxed', 'sha256' => $hSB, 'mode' => 'sandboxed', 'caps' => ['ui.toast']]], null)['tier'] === 'untrusted');

if ($fails) { echo "\n$fails CLASSIFY CHECKS FAILED (php)\n"; exit(1); }
echo "\nALL TRUST-CLASSIFY CHECKS PASSED (php)\n";
