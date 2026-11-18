<?php
/* PHP twin of tests/test_stale_code.py: the code that EXECUTES knows its own release.

   The checkout keeps the placeholder ("unstamped"): no verdict, no refusal. A build
   stamps it; a stamped copy whose changelog folder holds a newer version is stale:
   the status says so (parked files, opcache findings, the one recovery attempt) and
   install/update are refused with 409 stale_server_code. An unknown placement is
   409 unsupported_placement, a malformed id stays bad_plugin_id.

   The library is copied into a throwaway web root so changelog_dir() points at the
   fixtures; the stamped runs happen in a child process (the version is a constant).
     php tests/test_stale_code_php.php                                           */
declare(strict_types=1);

$PLACEHOLDER = '@@LUMEN_CODE_VERSION@@';
$src = (string)file_get_contents(__DIR__ . '/../api/_admin_lib.php');
$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}
function rrm(string $d): void {
    if (!is_dir($d)) return;
    foreach (scandir($d) ?: [] as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = "$d/$f";
        is_dir($p) ? rrm($p) : @unlink($p);
    }
    @rmdir($d);
}
/** A web root with a library copy (stamped with $stamp unless null) and these changelogs. */
function make_root(string $src, ?string $stamp, array $changelogs, string $placeholder): string {
    $root = sys_get_temp_dir() . '/lumen-stale-' . bin2hex(random_bytes(4));
    mkdir("$root/api", 0777, true);
    mkdir("$root/changelog", 0777, true);
    $code = $stamp === null ? $src : str_replace($placeholder, $stamp, $src);
    file_put_contents("$root/api/_admin_lib.php", $code);
    copy(__DIR__ . '/../api/_upload_lib.php', "$root/api/_upload_lib.php");
    foreach ($changelogs as $v) file_put_contents("$root/changelog/changelog_$v.md", "# $v\n");
    return $root;
}
$roots = [];
register_shutdown_function(function () use (&$roots) { foreach ($roots as $r) rrm($r); });
/** Run $php inside a child process that has loaded the library of $root. */
function child(string $root, string $php): array {
    $f = "$root/child.php";
    file_put_contents($f, "<?php require_once __DIR__ . '/api/_admin_lib.php';\n" . $php);
    $out = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($f) . ' 2>&1');
    $j = json_decode((string)$out, true);
    return is_array($j) ? $j : ['_raw' => $out];
}

echo "the checkout is unstamped\n";
check('the placeholder is in the source exactly once', substr_count($src, $PLACEHOLDER) === 1);
$r1 = make_root($src, null, ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r1;
$u = child($r1, 'echo json_encode(["v" => admin_code_version(), "s" => admin_code_status(), "g" => mkt_stale_guard(), "i" => mkt_install("x", "pw")]);');
check('no stamped version', array_key_exists('v', $u) && $u['v'] === null);
check('no verdict, no diagnosis', ($u['s']['stale'] ?? null) === false && array_key_exists('diagnosis', $u['s']) && $u['s']['diagnosis'] === null);
check('files version still reported', ($u['s']['filesVersion'] ?? null) === '1.3.0' && array_key_exists('codeVersion', $u['s']) && $u['s']['codeVersion'] === null);
check('install is not refused as stale', array_key_exists('g', $u) && $u['g'] === null
    && ($u['i'][1]['error'] ?? '') !== 'stale_server_code');

echo "\na stamped build whose files match\n";
$r2 = make_root($src, '1.3.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r2;
$m = child($r2, 'echo json_encode(["s" => admin_code_status(), "g" => mkt_stale_guard()]);');
check('codeVersion = filesVersion, not stale', ($m['s']['codeVersion'] ?? null) === '1.3.0' && ($m['s']['stale'] ?? null) === false);
check('install is not refused', array_key_exists('g', $m) && $m['g'] === null);

echo "\na stamped build older than its files, with a parked file\n";
$r3 = make_root($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r3;
file_put_contents("$r3/api/admin.php.lumen-new", "<?php // parked\n");
file_put_contents("$r3/api/.update-pending.json", json_encode(['api/admin.php']));
$s = child($r3, 'echo json_encode(["s" => admin_code_status(), "g" => mkt_stale_guard(), "i" => mkt_install("x", "pw")]);');
check('stale with both versions', ($s['s']['stale'] ?? null) === true && ($s['s']['codeVersion'] ?? null) === '1.2.0' && ($s['s']['filesVersion'] ?? null) === '1.3.0');
check('diagnosis has nothing parked once the recovery swapped it', ($s['s']['diagnosis']['parked'] ?? null) === []);
check('diagnosis carries the opcache findings', is_array($s['s']['diagnosis']['opcache'] ?? null) && array_key_exists('restrictApi', $s['s']['diagnosis']['opcache']) && array_key_exists('validateTimestamps', $s['s']['diagnosis']['opcache']));
check('the recovery ran once and reports it', is_array($s['s']['diagnosis']['recovery'] ?? null) && ($s['s']['diagnosis']['recovery']['parkedBefore'] ?? null) === 1);
check('the parked file was swapped in by the recovery', is_file("$r3/api/admin.php") && !is_file("$r3/api/admin.php.lumen-new"));
check('install guard answers 409 stale_server_code with both versions',
    ($s['g'][0] ?? null) === 409 && ($s['g'][1]['error'] ?? null) === 'stale_server_code'
    && ($s['g'][1]['codeVersion'] ?? null) === '1.2.0' && ($s['g'][1]['filesVersion'] ?? null) === '1.3.0');
check('mkt_install refuses before any other check', ($s['i'][0] ?? null) === 409 && ($s['i'][1]['error'] ?? null) === 'stale_server_code');

echo "\na parked file that cannot be swapped stays in the diagnosis\n";
$r4 = make_root($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r4;
// The entry script being executed is never swapped by its own request (the next
// request through another endpoint finalizes it), so it stays parked.
file_put_contents("$r4/child.php.lumen-new", "<?php // parked
");
file_put_contents("$r4/api/.update-pending.json", json_encode(['child.php']));
$b = child($r4, 'echo json_encode(["s" => admin_code_status()]);');
check('the file is still reported as parked', ($b['s']['diagnosis']['parked'] ?? null) === ['child.php']);
check('and the recovery says it left it', ($b['s']['diagnosis']['recovery']['parkedAfter'] ?? null) === 1);

echo "\nthe reset is throttled, the per-file invalidation is not\n";
$r5 = make_root($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r5;
$t = child($r5, 'echo json_encode(["a" => admin_code_status(), "b" => admin_code_status()]);');
check('the first call runs the recovery', ($t['a']['diagnosis']['recovery']['throttled'] ?? null) === false);
check('the second call still tries every file (no throttle on invalidation)',
    ($t['b']['diagnosis']['recovery']['filesTried'] ?? -1) === ($t['a']['diagnosis']['recovery']['filesTried'] ?? -2)
    && ($t['b']['diagnosis']['recovery']['filesTried'] ?? 0) > 0);
check('the attempt is recorded in api/.stale-recovery.json', is_file("$r5/api/.stale-recovery.json"));
check('a code older than its files says code_older', ($t['a']['diagnosis']['direction'] ?? null) === 'code_older');
check('without opcache functions nothing is invalidated nor reset (CLI)', ($t['a']['diagnosis']['recovery']['invalidated'] ?? -1) === 0);
$t2 = child($r5, '$r = admin_recover_stale_code(); echo json_encode(["r" => $r, "reset" => function_exists("opcache_reset")]);');
check('the recovery result keeps its documented shape', is_array($t2['r'] ?? null)
    && array_keys($t2['r']) === ['parkedBefore', 'parkedAfter', 'swapped', 'invalidated', 'filesTried', 'opcacheReset', 'throttled', 'touched', 'touchFailed', 'libTouched', 'touchFailedFiles']);
if (!empty($t2['reset'])) {
    check('inside the window the reset is skipped and reported as throttled',
        ($t2['r']['throttled'] ?? null) === true && ($t2['r']['opcacheReset'] ?? null) === false);
} else {
    echo "  note  opcache_reset is not available on this CLI; the throttled reset is not exercised\n";
}

echo "\nthe updater gives what it installs the modification time of now\n";
$r8 = make_root($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r8;
$old80 = 315532800;
file_put_contents("$r8/api/target.php", "<?php // old\n");
file_put_contents("$r8/api/incoming.php", "<?php // new\n");
touch("$r8/api/target.php", $old80);
touch("$r8/api/incoming.php", $old80);   // what extractTo restores from a release built before 1.84.3
$pl = child($r8, '$ok = admin_update_place_file(__DIR__ . "/api/incoming.php", __DIR__ . "/api/target.php"); clearstatcache();'
    . ' echo json_encode(["ok" => $ok, "mtime" => filemtime(__DIR__ . "/api/target.php"), "body" => file_get_contents(__DIR__ . "/api/target.php"),'
    . ' "gone" => !is_file(__DIR__ . "/api/incoming.php"), "now" => time()]);');
check('the new bytes are in place', ($pl['ok'] ?? null) === true && ($pl['body'] ?? '') === "<?php // new\n" && ($pl['gone'] ?? null) === true);
check('a file dated 1980 ends up with a recent mtime', isset($pl['mtime']) && $pl['mtime'] > $pl['now'] - 120);
check('the old copy is parked beside it for the sweep', is_file("$r8/api/target.php.lumen-old"));
file_put_contents("$r8/api/parked.php", "<?php // old\n");
file_put_contents("$r8/api/parked.php.lumen-new", "<?php // new\n");
touch("$r8/api/parked.php.lumen-new", $old80);
file_put_contents("$r8/api/.update-pending.json", json_encode(['api/parked.php']));
$fp = child($r8, '$n = admin_update_finish_pending(); clearstatcache(); echo json_encode(["n" => $n, "mtime" => filemtime(__DIR__ . "/api/parked.php"), "now" => time()]);');
check('a parked file swapped in later is dated now too', ($fp['n'] ?? null) === 1 && isset($fp['mtime']) && $fp['mtime'] > $fp['now'] - 120);
$tn = child($r8, 'echo json_encode(["missing" => admin_touch_now(__DIR__ . "/api/none.php")]);');
check('touching a missing file is false, never an error', ($tn['missing'] ?? null) === false);

echo "\nthe recovery touches the files that match the release when nothing could be invalidated\n";
$r9 = make_root($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r9;
copy(__DIR__ . '/../api/_code_probe.php', "$r9/api/_code_probe.php");
file_put_contents("$r9/api/admin.php", "<?php // admin\n");
$files9 = [];
foreach (['api/_admin_lib.php', 'api/admin.php'] as $rel) $files9[$rel] = hash_file('sha256', "$r9/$rel");
$files9['api/_upload_lib.php'] = str_repeat('0', 64);   // a shipped file that is NOT what the manifest says
file_put_contents("$r9/api/code-manifest.json", json_encode(['version' => '1.3.0', 'files' => $files9]));
foreach (glob("$r9/api/*.php") as $f) touch($f, $old80);
$rc = child($r9, 'echo json_encode(["r" => admin_recover_stale_code(), "now" => time()]);');
clearstatcache();
check('two files touched, none failed', ($rc['r']['touched'] ?? null) === 2 && ($rc['r']['touchFailed'] ?? null) === 0);
check('the matching files are recent', filemtime("$r9/api/_admin_lib.php") > time() - 120 && filemtime("$r9/api/admin.php") > time() - 120);
check('the outdated file kept its date', filemtime("$r9/api/_upload_lib.php") === $old80);

echo "\ncode NEWER than its files (an update that stopped half-way)\n";
$r6 = make_root($src, '1.4.0', ['1.2.0', '1.3.0'], $PLACEHOLDER); $roots[] = $r6;
$n = child($r6, 'echo json_encode(["s" => admin_code_status(), "g" => mkt_stale_guard()]);');
check('stale, direction code_newer, no recovery run', ($n['s']['stale'] ?? null) === true && ($n['s']['diagnosis']['direction'] ?? null) === 'code_newer'
    && array_key_exists('recovery', $n['s']['diagnosis']) && $n['s']['diagnosis']['recovery'] === null && !is_file("$r6/api/.stale-recovery.json"));
check('install is still refused', ($n['g'][1]['error'] ?? null) === 'stale_server_code');

echo "\nthe listing, run for real against a local catalog\n";
// The constants are fixed in the library, so the throwaway copy gets an unkeyed
// marketplace (integrity only) whose catalog URL is a local file.
$r7 = make_root($src, null, ['1.3.0'], $PLACEHOLDER); $roots[] = $r7;
file_put_contents("$r7/catalog.json", json_encode(['serial' => 1, 'plugins' => [
    ['id' => 'adv', 'placement' => 'studio', 'latestVersion' => '1.0.0', 'platformCompat' => null],
    ['id' => 'odd', 'placement' => 'widgets', 'latestVersion' => '1.0.0', 'platformCompat' => null],
    ['id' => 'num', 'placement' => 5, 'latestVersion' => '1.0.0', 'platformCompat' => null],
]]));
$lib = (string)file_get_contents("$r7/api/_admin_lib.php");
$lib = preg_replace("/const MARKETPLACE_PUBKEY\s*=\s*'[0-9a-f]*';/", "const MARKETPLACE_PUBKEY = '';", $lib, 1, $c1);
$lib = preg_replace("/const MARKETPLACE_CATALOG_URL\s*=\s*'[^']*';/", "const MARKETPLACE_CATALOG_URL = 'file://" . str_replace('\\', '/', $r7) . "/catalog.json';", $lib, 1, $c2);
file_put_contents("$r7/api/_admin_lib.php", $lib);
check('the library constants could be pointed at the fixture', $c1 === 1 && $c2 === 1);
$l = child($r7, 'echo json_encode(mkt_list());');
$byId = [];
foreach (($l['plugins'] ?? []) as $e) $byId[$e['id']] = $e;
check('the catalog was read', count($byId) === 3);
check('a hosted placement stays compatible', ($byId['adv']['compat'] ?? null) === true);
check('an unknown placement is compat:false and names it', ($byId['odd']['compat'] ?? null) === false && strpos((string)($byId['odd']['compatReason'] ?? ''), "'widgets'") !== false);
check('a non-string placement reads "(none)" like the Python twin', ($byId['num']['compat'] ?? null) === false && strpos((string)($byId['num']['compatReason'] ?? ''), '(none)') !== false);
$p = child($r7, 'echo json_encode(mkt_entry_problem(["id" => "x", "placement" => 5]));');
check('a non-string placement is reported as an empty name', ($p[1]['placement'] ?? null) === '');

echo "\nadmin.php: the version action and the install door\n";
/** Run api/admin.php for `$action` in a child with an authenticated fake session. */
function run_admin(string $root, string $action, string $method = 'GET'): array {
    $f = "$root/run_admin.php";
    $stamp = substr(hash('sha256', 'x|1'), 0, 32);
    file_put_contents($f, "<?php\n\$_GET['action'] = " . var_export($action, true) . ";\n\$_SERVER['REQUEST_METHOD'] = " . var_export($method, true) . ";\n"
        . "\$_SERVER['HTTP_X_CSRF_TOKEN'] = 'tok';\nsession_save_path(sys_get_temp_dir()); session_start();\n"
        . "\$_SESSION = ['admin_authenticated' => true, 'auth_at' => time(), 'cred_stamp' => '$stamp', 'csrf' => 'tok'];\n"
        . "require __DIR__ . '/api/admin.php';\n");
    $out = shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($f) . ' 2>&1');
    $j = json_decode((string)$out, true);
    return is_array($j) ? $j : ['_raw' => $out];
}
function admin_root_with(string $src, ?string $stamp, array $changelogs, string $placeholder, bool $oldLib): string {
    $root = make_root($src, $stamp, $changelogs, $placeholder);
    copy(__DIR__ . '/../api/admin.php', "$root/api/admin.php");
    file_put_contents("$root/api/admin_credential.json", json_encode(['password_pbkdf2' => 'x', 'rotated' => '1']));
    if ($oldLib) {
        // A library from before the stale-code check: the entry point is new, the library is not.
        $lib = (string)file_get_contents("$root/api/_admin_lib.php");
        $lib = str_replace(['function admin_code_status(', 'function mkt_stale_guard('], ['function admin_code_status_old(', 'function mkt_stale_guard_old('], $lib);
        file_put_contents("$root/api/_admin_lib.php", $lib);
    }
    return $root;
}
$a1 = admin_root_with($src, '1.3.0', ['1.3.0'], $PLACEHOLDER, false); $roots[] = $a1;
$v = run_admin($a1, 'version');
check('version answers the four new fields', array_key_exists('codeVersion', $v) && ($v['codeVersion'] ?? null) === '1.3.0' && ($v['filesVersion'] ?? null) === '1.3.0'
    && ($v['codeStale'] ?? null) === false && array_key_exists('codeDiagnosis', $v) && ($v['web'] ?? null) === '1.3.0');
$a2 = admin_root_with($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER, false); $roots[] = $a2;
$v = run_admin($a2, 'version');
check('a stale host reports stale with its diagnosis', ($v['codeStale'] ?? null) === true && ($v['codeDiagnosis']['backend'] ?? null) === 'php');
$a3 = admin_root_with($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER, true); $roots[] = $a3;
$v = run_admin($a3, 'version');
check('a new entry point over an older library reports instead of a 500', ($v['codeStale'] ?? null) === true && ($v['filesVersion'] ?? null) === '1.3.0'
    && array_key_exists('codeVersion', $v) && $v['codeVersion'] === null && ($v['codeDiagnosis']['libraryOutdated'] ?? null) === true && !isset($v['error']));
$i = run_admin($a3, 'install_plugin', 'POST');
check('install over an older library is refused as stale_server_code, not bad_plugin_id', ($i['error'] ?? null) === 'stale_server_code' && array_key_exists('codeVersion', $i) && $i['codeVersion'] === null);
$i = run_admin($a3, 'update_plugin', 'POST');
check('update over an older library is refused the same way', ($i['error'] ?? null) === 'stale_server_code');

require_once __DIR__ . '/../api/_admin_lib.php';
echo "\nreinstall guard\n";
check('a newer release is always applied', admin_update_target_ok('1.84.2', '1.84.1', false) && admin_update_target_ok('1.84.2', '1.84.1', true));
check('the same version needs an explicit reinstall', !admin_update_target_ok('1.84.1', '1.84.1', false) && admin_update_target_ok('1.84.1', '1.84.1', true));
check('an older release is never applied', !admin_update_target_ok('1.84.0', '1.84.1', true) && !admin_update_target_ok('1.9.0', '1.84.1', true));
check('an empty tag is never applied', !admin_update_target_ok('', '1.84.1', true));
// Reinstall installs exactly the version on disk, never another release.
check('reinstall same version is allowed', admin_update_target_verdict('1.84.1', '1.84.1', true) === '');
check('reinstall with a newer release is a mismatch', admin_update_target_verdict('1.85.0', '1.84.1', true) === 'reinstall_version_mismatch');
check('reinstall with an older release is a mismatch', admin_update_target_verdict('1.84.0', '1.84.1', true) === 'reinstall_version_mismatch');
check('reinstall with a different requested version is a mismatch', admin_update_target_verdict('1.84.1', '1.84.1', true, '1.84.0') === 'reinstall_version_mismatch');
check('reinstall with the matching requested version is allowed', admin_update_target_verdict('1.84.1', '1.84.1', true, '1.84.1') === '');
check('reinstall with an empty tag is refused', admin_update_target_verdict('', '1.84.1', true) !== '');
check('normal update: newer is allowed', admin_update_target_verdict('1.85.0', '1.84.1', false) === '');
check('normal update: same is refused', admin_update_target_verdict('1.84.1', '1.84.1', false) === 'no_update_available');
check('normal update: older is refused', admin_update_target_verdict('1.84.0', '1.84.1', false) === 'no_update_available');
check('normal update ignores a requested version', admin_update_target_verdict('1.85.0', '1.84.1', false, '1.84.1') === '');
check('a requested version is validated', admin_update_requested_version('v1.84.1') === '1.84.1' && admin_update_requested_version('1.84') === '' && admin_update_requested_version(['x']) === '' && admin_update_requested_version('1.84.1; rm') === '');
check('the library advertises reinstall support', defined('LUMEN_UPDATE_REINSTALL') && LUMEN_UPDATE_REINSTALL === true);
$rf = new ReflectionFunction('admin_update_apply_php');
check('admin_update_apply_php takes optional $reinstall and $requested', $rf->getNumberOfParameters() === 2 && $rf->getParameters()[0]->isOptional() && $rf->getParameters()[1]->isOptional() && $rf->getParameters()[0]->getName() === 'reinstall');

echo "\nthe permission repair names what it could not fix\n";
$r8 = make_root($src, null, ['1.3.0'], $PLACEHOLDER); $roots[] = $r8;
$pm = child($r8, 'echo json_encode(admin_apply_tree_modes());');
check('failedPaths and codeUnwritable are always present as lists', is_array($pm['failedPaths'] ?? null) && is_array($pm['codeUnwritable'] ?? null)
    && isset($pm['fixed'], $pm['failed'], $pm['scanned'], $pm['dirMode'], $pm['fileMode'], $pm['split']));
check('the code manifest is not treated as a secret', !admin_is_secret_path('api/code-manifest.json') && admin_is_secret_path('api/stats.json'));

echo "\nadmin.php: the probe rides on the version answer\n";
copy(__DIR__ . '/../api/_code_probe.php', "$a2/api/_code_probe.php");
$v = run_admin($a2, 'version');
check('a stale host carries probe.cause', is_array($v['codeDiagnosis']['probe'] ?? null)
    && in_array($v['codeDiagnosis']['probe']['cause'] ?? '', ['opcache', 'not_written', 'incomplete', 'unknown'], true));
check('the probe sees the executing and files versions', ($v['codeDiagnosis']['probe']['executingVersion'] ?? null) === '1.2.0'
    && ($v['codeDiagnosis']['probe']['filesVersion'] ?? null) === '1.3.0');
check('the probe ran its recovery', is_array($v['codeDiagnosis']['probe']['recovery'] ?? null));
check('reinstallSupported is advertised', ($v['reinstallSupported'] ?? null) === true);
copy(__DIR__ . '/../api/_code_probe.php', "$a3/api/_code_probe.php");
$v = run_admin($a3, 'version');
check('over an OLD library the probe still answers, executing version unknown', is_array($v['codeDiagnosis']['probe'] ?? null)
    && ($v['codeDiagnosis']['libraryOutdated'] ?? null) === true
    && array_key_exists('executingVersion', $v['codeDiagnosis']['probe']) && $v['codeDiagnosis']['probe']['executingVersion'] === null);
check('the probe names the stamped-1.2.0 library as late', ($v['codeDiagnosis']['probe']['cause'] ?? null) === 'not_written'
    && ($v['codeDiagnosis']['probe']['outdated'][0]['path'] ?? null) === 'api/_admin_lib.php');
$v = run_admin($a1, 'version');
check('a healthy host carries no probe', !isset($v['codeDiagnosis']['probe']) && ($v['codeStale'] ?? null) === false);
file_put_contents("$a3/api/_admin_lib.php", str_replace('const LUMEN_UPDATE_REINSTALL = true;', '', (string)file_get_contents("$a3/api/_admin_lib.php")));
$v = run_admin($a3, 'version');
check('a library without reinstall support is reported as such', ($v['reinstallSupported'] ?? null) === false);

echo "\nadmin.php: stale_fix\n";
$ACTION_IDS = ['finish_parked', 'invalidate', 'touch', 'repair_permissions', 'opcache_reset'];
$ids = function ($a) { return array_map(function ($x) { return $x['id']; }, is_array($a) ? $a : []); };
$g = run_admin($a1, 'stale_fix', 'GET');
check('stale_fix is a write action: a GET is refused', isset($g['error']) && !isset($g['actions']));
$z = run_admin($a1, 'stale_fix', 'POST');
check('code that is not stale: nothing to do', ($z['stale'] ?? null) === false && ($z['codeStale'] ?? null) === false && ($z['actions'] ?? null) === [] && ($z['next'] ?? null) === 'none'
    && ($z['codeVersion'] ?? null) === '1.3.0' && ($z['filesVersion'] ?? null) === '1.3.0');
// $a2: new library stamped 1.2.0 over files of 1.3.0, probe present.
$z = run_admin($a2, 'stale_fix', 'POST');
check('a stale host answers the five steps in order', ($z['stale'] ?? null) === true && $ids($z['actions'] ?? null) === $ACTION_IDS && !isset($z['error']));
check('every step has ran/ok booleans', count(array_filter($z['actions'] ?? [], function ($a) { return is_bool($a['ran'] ?? null) && is_bool($a['ok'] ?? null); })) === 5);
check('versions and the reinstall capability ride on the answer', ($z['codeVersion'] ?? null) === '1.2.0' && ($z['filesVersion'] ?? null) === '1.3.0' && ($z['codeStale'] ?? null) === true
    && ($z['reinstallSupported'] ?? null) === true);
check('the library on disk is the late file: permissions repaired, then reinstall', ($z['cause'] ?? null) === 'not_written' && ($z['actions'][3]['ran'] ?? null) === true && ($z['next'] ?? null) === 'reinstall');
// $a3: an OLD library (no admin_code_status, no reinstall support).
$z = run_admin($a3, 'stale_fix', 'POST');
check('over an older library: no fatal, stale, codeVersion unknown', ($z['stale'] ?? null) === true && array_key_exists('codeVersion', $z) && $z['codeVersion'] === null && !isset($z['error']) && !isset($z['_raw']));
check('without reinstall support the next step is manual and says why', ($z['next'] ?? null) === 'manual' && in_array('reinstall_unavailable', $z['reasons'] ?? [], true) && ($z['reinstallSupported'] ?? null) === false);
check('the five steps are still reported', $ids($z['actions'] ?? null) === $ACTION_IDS);
// An old library that also lacks the permission repair.
$a4 = admin_root_with($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER, true); $roots[] = $a4;
copy(__DIR__ . '/../api/_code_probe.php', "$a4/api/_code_probe.php");
$lib4 = (string)file_get_contents("$a4/api/_admin_lib.php");
file_put_contents("$a4/api/_admin_lib.php", str_replace(['function admin_apply_tree_modes(', 'const LUMEN_UPDATE_REINSTALL = true;'], ['function admin_apply_tree_modes_old(', ''], $lib4));
$z = run_admin($a4, 'stale_fix', 'POST');
check('a library without the permission repair: the step is reported as unavailable, nothing fatal', !isset($z['_raw']) && ($z['actions'][3]['ran'] ?? null) === false
    && ($z['actions'][3]['detail'] ?? null) === ['unavailable'] && ($z['next'] ?? null) === 'manual');
// No probe file at all: stale, manual, with the reason.
$a5 = admin_root_with($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER, false); $roots[] = $a5;
$z = run_admin($a5, 'stale_fix', 'POST');
check('without the probe file: stale, manual, probe_unavailable', ($z['stale'] ?? null) === true && ($z['next'] ?? null) === 'manual' && ($z['reasons'] ?? null) === ['probe_unavailable'] && ($z['actions'] ?? null) === []);
// A parked file is swapped by the fix.
$a6 = admin_root_with($src, '1.2.0', ['1.2.0', '1.3.0'], $PLACEHOLDER, false); $roots[] = $a6;
copy(__DIR__ . '/../api/_code_probe.php', "$a6/api/_code_probe.php");
file_put_contents("$a6/api/other.php.lumen-new", "<?php // parked\n");
file_put_contents("$a6/api/.update-pending.json", json_encode(['api/other.php']));
$z = run_admin($a6, 'stale_fix', 'POST');
check('the entry point itself already swaps parked files (admin.php does it at the door): nothing is left parked', !is_file("$a6/api/other.php.lumen-new") && is_file("$a6/api/other.php") && ($z['stale'] ?? null) === true);

echo "\nthe version override (a test seam; the endpoint never passes it)\n";
require_once __DIR__ . '/../api/_admin_lib.php';
check('a malformed stamp is unstamped', admin_code_version('not-a-version') === null && admin_code_version('1.2') === null);
check('a stamp parses', admin_code_version('1.84.1') === '1.84.1');
check('the placeholder constant of a checkout is unstamped', admin_code_version() === null);
check('the checkout never refuses an install as stale', mkt_stale_guard() === null);

echo "\nplacements\n";
check('studio is hosted', mkt_entry_problem(['id' => 'adv', 'placement' => 'studio']) === null);
foreach (['tools', 'channels', 'shaders'] as $pl) check("$pl is hosted", mkt_entry_problem(['id' => 'a', 'placement' => $pl]) === null);
$p = mkt_entry_problem(['id' => 'adv', 'placement' => 'widgets']);
check('unknown placement => 409 unsupported_placement naming it', ($p[0] ?? 0) === 409 && ($p[1]['error'] ?? '') === 'unsupported_placement' && ($p[1]['placement'] ?? '') === 'widgets');
$p = mkt_entry_problem(['id' => 'adv']);
check('missing placement is unsupported, not a bad id', ($p[1]['error'] ?? '') === 'unsupported_placement');
$p = mkt_entry_problem(['id' => '../x', 'placement' => 'tools']);
check('a malformed id stays bad_plugin_id', ($p[0] ?? 0) === 400 && ($p[1]['error'] ?? '') === 'bad_plugin_id');
$p = mkt_entry_problem(['id' => '../x', 'placement' => 'widgets']);
check('a malformed id wins over an unknown placement', ($p[1]['error'] ?? '') === 'bad_plugin_id');

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
