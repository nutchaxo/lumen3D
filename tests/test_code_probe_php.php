<?php
/* The stale-code probe (api/_code_probe.php, web 1.84.2).

   It must work WITHOUT the library (the library may be the very file that is old), so
   this test loads the probe alone, in throwaway web roots, and checks the verdicts:
   which file is late and what PHP may do about it, the library stamp read from the
   file's bytes, the manifest rules, the recovery shape.
     php tests/test_code_probe_php.php                                           */
declare(strict_types=1);

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
$roots = [];
register_shutdown_function(function () use (&$roots) { foreach ($roots as $r) rrm($r); });

/** A web root: api/_admin_lib.php stamped $libStamp, api/admin.php, router.php; optional manifest. */
function make_root(?string $libStamp, ?array $manifest, array $overrides = []): string {
    global $roots;
    $root = sys_get_temp_dir() . '/lumen-probe-' . bin2hex(random_bytes(4));
    mkdir("$root/api", 0777, true);
    $lib = $libStamp === null ? "<?php\nconst LUMEN_CODE_VERSION = '@@LUMEN_CODE_VERSION@@';\n"
                              : "<?php\nconst LUMEN_CODE_VERSION = '$libStamp';\n";
    $files = ['api/_admin_lib.php' => $lib, 'api/admin.php' => "<?php // admin\n", 'router.php' => "<?php // router\n"];
    foreach ($overrides as $rel => $body) $files[$rel] = $body;
    foreach ($files as $rel => $body) file_put_contents("$root/$rel", $body);
    if ($manifest !== null) {
        $hashes = [];
        foreach ($files as $rel => $body) $hashes[$rel] = hash('sha256', $body);
        // The manifest describes the release as built: $manifest['files'] overrides what it lists.
        $hashes = array_merge($hashes, $manifest['files'] ?? []);
        file_put_contents("$root/api/code-manifest.json", json_encode(['version' => $manifest['version'], 'files' => $hashes]));
    }
    $roots[] = $root;
    return $root;
}

// No library, no admin_* function: the probe must stand alone.
require_once __DIR__ . '/../api/_code_probe.php';
check('the probe is loaded without the library', !function_exists('admin_code_status') && !function_exists('admin_opcache_report'));
check('it only defines functions (requiring it twice is harmless)', (function () { require_once __DIR__ . '/../api/_code_probe.php'; return true; })());
$src = (string)file_get_contents(__DIR__ . '/../api/_code_probe.php');
check('it declares strict types and guards every function', strpos($src, 'declare(strict_types=1);') !== false
    && substr_count($src, 'function lumen_probe_') === substr_count($src, "if (!function_exists('lumen_probe_"));
$code = '';
foreach (token_get_all($src) as $tok) if (is_array($tok) && !in_array($tok[0], [T_COMMENT, T_DOC_COMMENT], true)) $code .= $tok[1]; else if (is_string($tok)) $code .= $tok;
check('it calls no admin_/mkt_ function (comments aside)', preg_match('/\b(admin|mkt)_[a-z_]+\s*\(/', $code) === 0);

echo "\nthe stamp is read from the bytes\n";
check('a stamped library parses', lumen_probe_stamp("<?php\nconst LUMEN_CODE_VERSION = '1.84.1';") === '1.84.1');
check('the checkout placeholder is no stamp', lumen_probe_stamp("<?php\nconst LUMEN_CODE_VERSION = '@@LUMEN_CODE_VERSION@@';") === null);
check('a file without the constant has none', lumen_probe_stamp("<?php echo 1;") === null);
check('versions compare as integers', lumen_probe_tuple('1.84.2') > lumen_probe_tuple('1.9.0') && lumen_probe_tuple('x') === [0, 0, 0]);

echo "\nmanifest current, one file differs: not_written, with its facts\n";
$r = make_root('1.84.2', ['version' => '1.84.2', 'files' => ['api/admin.php' => str_repeat('0', 64)]]);
$d = lumen_probe_diagnose($r, '1.84.2', null, false);
check('cause not_written', $d['cause'] === 'not_written');
check('exactly that file is outdated', count($d['outdated']) === 1 && $d['outdated'][0]['path'] === 'api/admin.php');
$o = $d['outdated'][0];
check('its facts are complete', $o['exists'] === true && array_key_exists('writable', $o) && array_key_exists('dirWritable', $o)
    && array_key_exists('owner', $o) && array_key_exists('group', $o) && array_key_exists('phpOwns', $o)
    && is_string($o['perms']) && preg_match('/^0[0-7]{3}$/', $o['perms']) === 1);
check('this process can write the file it created', $o['writable'] === true && $o['dirWritable'] === true);
check('the manifest is reported current', $d['manifest'] === ['present' => true, 'version' => '1.84.2', 'current' => true]);
check('the library stamp is read from the disk', $d['library']['diskVersion'] === '1.84.2' && $d['library']['path'] === 'api/_admin_lib.php');
check('no recovery when not asked', $d['recovery'] === null);
check('versions are echoed', $d['executingVersion'] === null && $d['filesVersion'] === '1.84.2');
check('the PHP user is named (or null)', array_key_exists('user', $d['php']));
foreach (['available', 'enabled', 'statusReadable', 'restrictApi', 'validateTimestamps', 'revalidateFreq'] as $k) {
    if (!array_key_exists($k, $d['opcache'])) { check("opcache.$k present", false); }
}
check('opcache has the admin_opcache_report shape', count($d['opcache']) === 6);

echo "\na missing file is outdated and says it does not exist\n";
$r = make_root('1.84.2', ['version' => '1.84.2']);
unlink("$r/router.php");
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.2', false);
check('router.php is listed as absent', $d['cause'] === 'not_written' && $d['outdated'][0]['path'] === 'router.php'
    && $d['outdated'][0]['exists'] === false && $d['outdated'][0]['perms'] === null && $d['outdated'][0]['phpOwns'] === null);

echo "\nno manifest: the library stamp alone decides\n";
$r = make_root('1.84.1', null);
$d = lumen_probe_diagnose($r, '1.84.2', null, false);
check('manifest absent', $d['manifest'] === ['present' => false, 'version' => null, 'current' => false]);
check('the old library is listed, cause not_written', $d['cause'] === 'not_written' && count($d['outdated']) === 1 && $d['outdated'][0]['path'] === 'api/_admin_lib.php');

echo "\nmanifest present but old: it is listed too\n";
$r = make_root('1.84.1', ['version' => '1.84.1']);
$d = lumen_probe_diagnose($r, '1.84.2', null, false);
$paths = array_map(function ($o) { return $o['path']; }, $d['outdated']);
check('manifest not current', $d['manifest']['present'] === true && $d['manifest']['current'] === false);
check('code-manifest.json and the library are listed', $paths === ['api/_admin_lib.php', 'api/code-manifest.json'] && $d['cause'] === 'not_written');
check('every fact has the replaceable flag', isset($d['outdated'][0]['replaceable']) && is_bool($d['outdated'][0]['replaceable']));

echo "
stale manifest alone, library right on disk: it never decides the cause
";
$r = make_root('1.84.2', ['version' => '1.84.1']);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.1', false);
$paths = array_map(function ($o) { return $o['path']; }, $d['outdated']);
check('only the manifest is listed', $paths === ['api/code-manifest.json']);
check('cause is opcache, not not_written', $d['cause'] === 'opcache');

echo "\neverything right on disk, the executing code older: opcache\n";
$r = make_root('1.84.2', ['version' => '1.84.2']);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.1', false);
check('cause opcache, nothing outdated', $d['cause'] === 'opcache' && $d['outdated'] === []);
$d = lumen_probe_diagnose($r, '1.84.2', null, false);
check('an executing version older than 1.84.1 (null) is opcache too', $d['cause'] === 'opcache');
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.2', false);
check('nothing wrong anywhere is unknown', $d['cause'] === 'unknown');

echo "\nthe library newer than the files: incomplete\n";
$r = make_root('1.84.3', null);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.2', false);
check('cause incomplete', $d['cause'] === 'incomplete');
$r = make_root('1.9.0', null);
$d = lumen_probe_diagnose($r, '1.10.0', null, false);
check('1.9.0 is older than 1.10.0 (integers, not strings)', $d['cause'] === 'not_written');

echo "\nhostile manifest entries are ignored\n";
$r = make_root('1.84.2', ['version' => '1.84.2', 'files' => ['../../etc/passwd' => str_repeat('1', 64), 'api/x.js' => str_repeat('1', 64), 'api/ok.php' => 5]]);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.2', false);
check('only shipped-looking PHP paths are hashed', $d['cause'] === 'unknown' && $d['outdated'] === []);

echo "\nrecovery\n";
$r = make_root('1.84.2', ['version' => '1.84.2']);
$served = count(glob("$r/api/*.php")) + count(glob("$r/*.php"));
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.1', true);
check('the recovery has its fields', is_array($d['recovery']) && array_keys($d['recovery']) === ['invalidated', 'tried', 'blocked', 'touched', 'touchFailed', 'libTouched', 'touchFailedFiles']);
if (function_exists('opcache_invalidate')) {
    check('tried counts the served files', $d['recovery']['tried'] === $served);
} else {
    check('without opcache functions nothing is tried and nothing is blocked', $d['recovery']['invalidated'] === 0 && $d['recovery']['tried'] === 0 && $d['recovery']['blocked'] === false);
}
$ini = ['enabled' => false];
check('opcache off is never "blocked"', lumen_probe_recover($r, $ini)['blocked'] === false);
if (function_exists('opcache_invalidate')) {
    $rc = lumen_probe_recover($r, ['enabled' => true]);
    check('enabled with zero successes out of tried files is blocked, with successes it is not',
        $rc['blocked'] === ($rc['tried'] > 0 && $rc['invalidated'] === 0));
}

echo "\nthe served files get a fresh modification time (cause opcache only)\n";
$old = 315532800;   // 1980-01-01, what releases before 1.84.3 installed everywhere
function age_all(string $r, int $t): void { foreach (array_merge(glob("$r/api/*"), glob("$r/*.php")) as $f) if (is_file($f)) touch($f, $t); }
$r = make_root('1.84.2', ['version' => '1.84.2']);
age_all($r, $old);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.1', true);
check('cause opcache', $d['cause'] === 'opcache');
check('every PHP file of the manifest is touched, none failed', $d['recovery']['touched'] === 3 && $d['recovery']['touchFailed'] === 0);
clearstatcache();
check('their mtime is recent', filemtime("$r/api/_admin_lib.php") > time() - 120 && filemtime("$r/router.php") > time() - 120);
check('the manifest itself is not served code and keeps its date', filemtime("$r/api/code-manifest.json") === $old);

$r = make_root('1.84.2', ['version' => '1.84.2', 'files' => ['api/admin.php' => str_repeat('0', 64)]]);
age_all($r, $old);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.1', true);
clearstatcache();
check('an outdated file means not_written and nothing is touched', $d['cause'] === 'not_written' && $d['recovery']['touched'] === 0
    && filemtime("$r/api/_admin_lib.php") === $old);
$t = lumen_probe_touch($r, '1.84.2');
clearstatcache();
check('lumen_probe_touch skips the outdated file, touches the others',
    $t === ['touched' => 2, 'touchFailed' => 0, 'libTouched' => true, 'touchFailedFiles' => []] && filemtime("$r/api/admin.php") === $old && filemtime("$r/router.php") > time() - 120);
$r = make_root('1.84.1', ['version' => '1.84.1']);
age_all($r, $old);
clearstatcache();
check('a manifest of another version is no authority, and the library stamp is not the files version',
    lumen_probe_touch($r, '1.84.2') === ['touched' => 0, 'touchFailed' => 0, 'libTouched' => null, 'touchFailedFiles' => []] && filemtime("$r/api/_admin_lib.php") === $old);
$r = make_root('1.84.2', null);
age_all($r, $old);
check('without a manifest only the library whose stamp is the files version is touched',
    lumen_probe_touch($r, '1.84.2') === ['touched' => 1, 'touchFailed' => 0, 'libTouched' => true, 'touchFailedFiles' => []]);
clearstatcache();
check('and it is the library', filemtime("$r/api/_admin_lib.php") > time() - 120 && filemtime("$r/router.php") === $old);
check('no files version, no touch', lumen_probe_touch($r, null) === ['touched' => 0, 'touchFailed' => 0, 'libTouched' => null, 'touchFailedFiles' => []]);
$r = make_root('1.84.2', ['version' => '1.84.2']);
age_all($r, $old);
$d = lumen_probe_diagnose($r, '1.84.2', '1.84.1', false);
clearstatcache();
check('no recovery asked, nothing touched', $d['recovery'] === null && filemtime("$r/api/_admin_lib.php") === $old);

echo "\na missing root never throws\n";
$d = lumen_probe_diagnose(sys_get_temp_dir() . '/lumen-probe-does-not-exist', '1.84.2', null, true);
check('verdict still returned', is_array($d) && in_array($d['cause'], ['not_written', 'opcache', 'incomplete', 'unknown'], true));

echo "\nlumen_probe_fix_next: what is left to do\n";
$base = ['reinstallable' => true, 'invalidated' => 0, 'swapped' => 0, 'resetOk' => false, 'touched' => 0, 'touchFailed' => 0, 'libTouched' => null,
    'validateTimestamps' => true, 'revalidateFreq' => 120, 'parkedLeft' => false, 'invalidateFailed' => false];
$n = function (string $cause, array $over = []) use ($base) { return lumen_probe_fix_next($cause, $over + $base); };
check('incomplete is manual, whatever was done', $n('incomplete', ['invalidated' => 9]) === ['next' => 'manual', 'waitSeconds' => 0, 'reasons' => ['incomplete']]);
check('not_written with a reinstall available: reinstall', $n('not_written')['next'] === 'reinstall');
check('not_written beats a dropped cache', $n('not_written', ['invalidated' => 9])['next'] === 'reinstall');
check('not_written without reinstall: manual, both reasons', $n('not_written', ['reinstallable' => false]) === ['next' => 'manual', 'waitSeconds' => 0, 'reasons' => ['not_written', 'reinstall_unavailable']]);
check('opcache invalidated: recheck', $n('opcache', ['invalidated' => 4])['next'] === 'recheck');
check('parked files swapped: recheck', $n('opcache', ['swapped' => 1])['next'] === 'recheck');
check('opcache_reset done: recheck', $n('unknown', ['resetOk' => true])['next'] === 'recheck');
check('dates refreshed under validate_timestamps: wait revalidate_freq', $n('opcache', ['touched' => 27]) === ['next' => 'wait', 'waitSeconds' => 120, 'reasons' => []]);
check('wait survives a failed touch of another file', $n('opcache', ['touched' => 27, 'touchFailed' => 1, 'libTouched' => true])['next'] === 'wait');
check('the library itself not touched: no wait', $n('opcache', ['touched' => 27, 'touchFailed' => 1, 'libTouched' => false])['next'] === 'manual');
check('validate_timestamps off: no wait', $n('opcache', ['touched' => 5, 'validateTimestamps' => false])['next'] === 'manual');
check('revalidate_freq 0: the very next request re-reads, recheck', $n('opcache', ['touched' => 5, 'revalidateFreq' => 0, 'invalidateFailed' => true]) === ['next' => 'recheck', 'waitSeconds' => 0, 'reasons' => []]);
check('revalidate_freq unknown: no wait', $n('opcache', ['touched' => 5, 'revalidateFreq' => null])['next'] === 'manual');
check('opcache not enabled: recheck', $n('opcache', ['opcacheEnabled' => false])['next'] === 'recheck' && $n('unknown', ['opcacheEnabled' => false])['next'] === 'recheck');
check('opcache not enabled does not hide a file PHP could not write', $n('not_written', ['opcacheEnabled' => false])['next'] === 'reinstall');
check('nothing touched: no wait', $n('opcache')['next'] === 'manual');
check('manual reasons: touch failed + blocked + parked', $n('opcache', ['touchFailed' => 28, 'invalidateFailed' => true, 'parkedLeft' => true])['reasons'] === ['parked', 'touch_failed', 'opcache_blocked']);
check('manual with no finding says reupload', $n('unknown')['reasons'] === ['reupload']);

echo "\nlumen_probe_fix beside an OLD library (no admin_* function at all)\n";
$ACTION_IDS = ['finish_parked', 'invalidate', 'touch', 'repair_permissions', 'opcache_reset'];
$ids = function (array $a) { return array_map(function ($x) { return $x['id']; }, $a); };
check('this process has no library function', !function_exists('admin_update_finish_pending') && !function_exists('admin_apply_tree_modes') && !defined('LUMEN_UPDATE_REINSTALL'));
// opcache cause: files right, the executing code older.
$r = make_root('1.84.3', ['version' => '1.84.3']);
age_all($r, $old);
$f = lumen_probe_fix($r, '1.84.3', '1.84.2');
check('answer shape', $f['stale'] === true && $f['cause'] === 'opcache' && $ids($f['actions']) === $ACTION_IDS
    && in_array($f['next'], ['recheck', 'wait', 'manual'], true) && is_int($f['waitSeconds']) && is_array($f['reasons']));
foreach ($f['actions'] as $a) if (!array_key_exists('ran', $a) || !array_key_exists('ok', $a) || !is_bool($a['ran']) || !is_bool($a['ok'])) { check('every action has ran/ok booleans', false); break; }
check('invalidate and touch ran, the others did not', $f['actions'][1]['ran'] === true && $f['actions'][2]['ran'] === true
    && $f['actions'][0]['ran'] === false && $f['actions'][3]['ran'] === false && $f['actions'][4]['ran'] === false);
check('touch refreshed the three files, none failed', $f['actions'][2]['count'] === 3 && $f['actions'][2]['failed'] === 0 && $f['actions'][2]['ok'] === true);
clearstatcache();
check('their dates are fresh', filemtime("$r/api/_admin_lib.php") > time() - 120);
$oc = lumen_probe_opcache();
$expect = $f['actions'][1]['count'] > 0 || empty($oc['enabled']) ? 'recheck'
    : (($oc['validateTimestamps'] === true && $oc['revalidateFreq'] === 0) ? 'recheck'
    : (($oc['validateTimestamps'] === true && ($oc['revalidateFreq'] ?? 0) > 0) ? 'wait' : 'manual'));
check('next follows what happened on this host (' . $expect . ')', $f['next'] === $expect);
// not_written: the library on disk is older than the files.
$r = make_root('1.84.2', null);
$f = lumen_probe_fix($r, '1.84.3', null);
check('not_written without library functions or reinstall: manual with both reasons', $f['cause'] === 'not_written' && $f['next'] === 'manual'
    && $f['reasons'] === ['not_written', 'reinstall_unavailable']);
check('permissions step could not run, said so', $f['actions'][3]['ran'] === false && $f['actions'][3]['detail'] === ['unavailable']);
check('nothing was invalidated or touched for a file that is itself outdated', $f['actions'][1]['ran'] === false && $f['actions'][2]['ran'] === false);
// incomplete
$r = make_root('1.84.4', null);
$f = lumen_probe_fix($r, '1.84.3', '1.84.3');
check('incomplete is manual', $f['cause'] === 'incomplete' && $f['next'] === 'manual' && $f['reasons'] === ['incomplete']);
// parked files with the library unable to finish them
$r = make_root('1.84.3', ['version' => '1.84.3']);
file_put_contents("$r/api/foo.php.lumen-new", "<?php // parked\n");
file_put_contents("$r/api/.update-pending.json", json_encode(['api/foo.php', 'api/gone.php']));
check('lumen_probe_parked lists only files whose .lumen-new exists', lumen_probe_parked($r) === ['api/foo.php']);
$f = lumen_probe_fix($r, '1.84.3', '1.84.2');
check('without the library the parked file stays, nothing fatal', $f['actions'][0]['ran'] === false && is_file("$r/api/foo.php.lumen-new") && $f['stale'] === true);
check('and when it blocks everything else, it is a reason', $f['next'] !== 'manual' || in_array('parked', $f['reasons'], true));
// a root that does not exist never throws
$f = lumen_probe_fix(sys_get_temp_dir() . '/lumen-probe-nope', '1.84.3', null);
check('a missing root still answers', $f['stale'] === true && $ids($f['actions']) === $ACTION_IDS);
// A null files version: no touch, no wait.
$f = lumen_probe_fix($r, null, '1.84.2');
check('unknown files version: nothing touched', $f['actions'][2]['ran'] === false);

echo "\nlumen_probe_fix with the library's functions present\n";
// Declared inside a condition: PHP defines these only when execution reaches them (a top-level function exists from the start).
if (!function_exists('admin_update_finish_pending')) {
function admin_update_finish_pending(): int {
    $n = 0;
    foreach (glob($GLOBALS['fixRoot'] . '/api/*.lumen-new') ?: [] as $p) { rename($p, substr($p, 0, -strlen('.lumen-new'))); $n++; }
    return $n;
}
function admin_apply_tree_modes(): array {
    return ['fixed' => 3, 'failed' => 1, 'failedPaths' => ['api/x.php'], 'codeUnwritable' => ['api/_admin_lib.php'], 'scanned' => 10];
}
}
$r = make_root('1.84.3', ['version' => '1.84.3']);
$GLOBALS['fixRoot'] = $r;
file_put_contents("$r/api/foo.php.lumen-new", "<?php // parked\n");
file_put_contents("$r/api/.update-pending.json", json_encode(['api/foo.php']));
$f = lumen_probe_fix($r, '1.84.3', '1.84.2');
check('parked files are swapped and reported in order', $f['actions'][0] === ['id' => 'finish_parked', 'ran' => true, 'ok' => true, 'count' => 1, 'failed' => 0]
    && is_file("$r/api/foo.php") && !is_file("$r/api/foo.php.lumen-new"));
check('a swap means recheck', $f['next'] === 'recheck');
// permissions only when files could not be written
$r = make_root('1.84.2', null);
$GLOBALS['fixRoot'] = $r;
$f = lumen_probe_fix($r, '1.84.3', null);
check('not_written runs the permission repair and lists what it could not fix', $f['actions'][3]['ran'] === true && $f['actions'][3]['ok'] === false
    && $f['actions'][3]['count'] === 3 && $f['actions'][3]['failed'] === 1 && $f['actions'][3]['detail'] === ['api/x.php', 'api/_admin_lib.php']);
check('unwritable code is a reason', in_array('unwritable', $f['reasons'], true));
$r = make_root('1.84.3', ['version' => '1.84.3']);
$GLOBALS['fixRoot'] = $r;
age_all($r, $old);
$f = lumen_probe_fix($r, '1.84.3', '1.84.2');
check('the permission walk is skipped when nothing could not be written', $f['actions'][3]['ran'] === false && !isset($f['actions'][3]['detail']));
// The door of admin.php swapped the parked files before the fix ran: they still count.
$r = make_root('1.84.3', ['version' => '1.84.3']);
$GLOBALS['fixRoot'] = $r;
$GLOBALS['lumen_pending_swapped'] = 2;
$f = lumen_probe_fix($r, '1.84.3', '1.84.2');
check('door swaps are reported and mean recheck', $f['actions'][0] === ['id' => 'finish_parked', 'ran' => true, 'ok' => true, 'count' => 2, 'failed' => 0] && $f['next'] === 'recheck');
unset($GLOBALS['lumen_pending_swapped']);
$oc = lumen_probe_opcache();
if (empty($oc['enabled'])) {
    $r = make_root('1.84.3', ['version' => '1.84.3']);
    $GLOBALS['fixRoot'] = $r;
    $f = lumen_probe_fix($r, '1.84.3', '1.84.2');
    check('without opcache the answer is recheck, never opcache_blocked', $f['next'] === 'recheck' && !in_array('opcache_blocked', $f['reasons'], true));
}
define('LUMEN_UPDATE_REINSTALL', true);
$r = make_root('1.84.2', null);
$GLOBALS['fixRoot'] = $r;
$f = lumen_probe_fix($r, '1.84.3', null);
check('a library that reinstalls: next reinstall', $f['next'] === 'reinstall' && $f['reasons'] === ['unwritable']);

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
