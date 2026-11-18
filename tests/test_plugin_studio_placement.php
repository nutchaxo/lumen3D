<?php
/* PHP twin of the `studio` plugin placement checks (tests/test_dev_server_plugins.py,
   tests/js/test_plugin_studio_placement.mjs): the PHP backend discovers, lists, trusts
   and uninstalls a plugin placed under js/modules/studio/<id>/ exactly as the Python
   server does, and never offers it the sandbox lane.

   Runs against a throw-away copy of api/ (admin_root() is dirname(__DIR__), so the copy
   brings its own js/modules and changelog) — the repository tree is never touched.
   Run: php tests/test_plugin_studio_placement.php */
declare(strict_types=1);

$fails = 0;
function check(string $name, $cond): void { global $fails; echo ($cond ? "  ok   " : "  FAIL ") . "$name\n"; if (!$cond) $fails++; }
function rrm(string $p): void {
    if (is_link($p) || is_file($p)) { @unlink($p); return; }
    if (!is_dir($p)) return;
    foreach (scandir($p) ?: [] as $n) { if ($n !== '.' && $n !== '..') rrm("$p/$n"); }
    @rmdir($p);
}

$repo = dirname(__DIR__);
$tmp = sys_get_temp_dir() . '/lumen-studio-' . bin2hex(random_bytes(4));
mkdir("$tmp/api", 0777, true);
mkdir("$tmp/changelog", 0777, true);
mkdir("$tmp/.git", 0777, true);                                   // a checkout: dev trust may be switched on
foreach (glob("$repo/api/*.php") ?: [] as $f) copy($f, "$tmp/api/" . basename($f));
if (is_file("$repo/api/ca-bundle.pem")) copy("$repo/api/ca-bundle.pem", "$tmp/api/ca-bundle.pem");
file_put_contents("$tmp/changelog/changelog_1.83.0.md", "# 1.83.0\n");

$plug = "$tmp/js/modules/studio/adv";
mkdir("$plug/lang", 0777, true);
file_put_contents("$plug/plugin.json", json_encode([
    'id' => 'adv', 'name' => 'Adv', 'version' => '1.0.0', 'placement' => 'studio',
    'scripts' => ['a.js'], 'styles' => ['s.css'], 'platformCompat' => '>=1.83.0',
]));
file_put_contents("$plug/index.js", "/* i */");
file_put_contents("$plug/a.js", "/* a */");
file_put_contents("$plug/s.css", ".x{}");
file_put_contents("$plug/lang/en.json", "{}");
// A plugin whose plugin.json lies about its placement must be skipped (directory wins).
mkdir("$tmp/js/modules/tools/liar", 0777, true);
file_put_contents("$tmp/js/modules/tools/liar/plugin.json", json_encode(['id' => 'liar', 'placement' => 'studio']));

try {
    // ── in-process: the admin library ────────────────────────────────────────
    require_once "$tmp/api/_admin_lib.php";
    $list = admin_list_plugins();
    $paths = array_map(fn($p) => $p['path'], $list);
    check('admin_list_plugins lists studio/adv', in_array('studio/adv', $paths, true));
    check('placement-from-directory contract (tools/liar skipped)', !in_array('tools/liar', $paths, true));
    $adv = null; foreach ($list as $p) if ($p['path'] === 'studio/adv') $adv = $p;
    check('studio plugin carries its placement', $adv && $adv['placement'] === 'studio');
    check('scripts/styles survive in the listing', $adv && $adv['scripts'] === ['a.js'] && $adv['styles'] === ['s.css']);

    // the verified file set a client re-hashes covers the declared scripts and styles
    $hashes = admin_plugin_file_hashes($plug);
    check('trust hash covers index.js, a.js, s.css, lang/en.json',
        isset($hashes['index.js'], $hashes['a.js'], $hashes['s.css'], $hashes['lang/en.json']));

    // bad placements are refused, studio accepted
    [$st, $body] = mkt_uninstall('bogus/adv');
    check('uninstall refuses an unknown placement', $st === 400 && ($body['error'] ?? '') === 'bad_path');
    [$st, $body] = mkt_uninstall('studio/nope');
    check('uninstall of an absent studio plugin -> 404 (path accepted)', $st === 404 && ($body['error'] ?? '') === 'not_installed');

    // ── discovery endpoint, run as a script (like the web server would) ──────
    $php = PHP_BINARY;
    $out = shell_exec('LUMEN_DEV_TRUST=1 ' . escapeshellarg($php) . ' ' . escapeshellarg("$tmp/api/plugins.php") . ' 2>&1');
    if (PHP_OS_FAMILY === 'Windows') {
        putenv('LUMEN_DEV_TRUST=1');
        $out = shell_exec(escapeshellarg($php) . ' ' . escapeshellarg("$tmp/api/plugins.php") . ' 2>&1');
    }
    $json = null;
    if (is_string($out)) { $i = strpos($out, '{'); if ($i !== false) $json = json_decode(substr($out, $i), true); }
    check('api/plugins.php answers JSON', is_array($json) && isset($json['plugins']));
    $found = null;
    foreach (($json['plugins'] ?? []) as $p) if (($p['path'] ?? '') === 'studio/adv') $found = $p;
    check('api/plugins.php discovers studio/adv', $found !== null);
    if ($found) {
        check('discovered entry has placement studio', $found['placement'] === 'studio');
        $tier = $found['trust']['tier'] ?? null;
        check('studio plugin is vouched in-page (dev), not sandboxed', $tier === 'dev');
        $vf = $found['trust']['files'] ?? [];
        check('vouch lists the declared script and style', in_array('a.js', $vf, true) && in_array('s.css', $vf, true));
    }
    $man = @file_get_contents("$tmp/js/modules/manifest.json");
    $mj = $man ? json_decode($man, true) : null;
    $mp = $mj ? array_map(fn($e) => $e['path'], $mj['plugins']) : [];
    check('manifest.json (static fallback) carries studio/adv', in_array('studio/adv', $mp, true));
    putenv('LUMEN_DEV_TRUST');
} finally {
    rrm($tmp);
}

// ── the install / approve / toggle routes name the placement (twin of dev_server.py) ─
$lib = file_get_contents("$repo/api/_admin_lib.php");
$adm = file_get_contents("$repo/api/admin.php");
check('the hosted placements include studio, and install, list and the plugin scan all read them',
    strpos($lib, "const LUMEN_PLUGIN_PLACEMENTS = ['tools', 'channels', 'shaders', 'studio'];") !== false
    && substr_count($lib, 'LUMEN_PLUGIN_PLACEMENTS') >= 4
    && strpos($lib, 'function mkt_entry_problem') !== false);
check('mkt_install creates the placement folder before the rename (admin_make_dir(dirname($targetDir)))',
    strpos($lib, 'admin_make_dir(dirname($targetDir));') !== false);
check('mkt_install never picks the sandbox lane for a studio plugin',
    strpos($lib, "\$wantsSandbox = \$placement !== 'studio' &&") !== false);
check('approve/toggle path regex names studio', strpos($adm, '(tools|channels|shaders|studio)') !== false
    && strpos($lib, '(tools|channels|shaders|studio)') !== false);
check('approving a studio plugin as sandboxed is refused',
    strpos($adm, "strpos(\$path, 'studio/') === 0 && \$mode === 'sandboxed'") !== false);

if ($fails) { echo "\n$fails STUDIO PLACEMENT CHECKS FAILED (php)\n"; exit(1); }
echo "\nALL STUDIO PLACEMENT CHECKS PASSED (php)\n";
