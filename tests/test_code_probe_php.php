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
check('the recovery has its three fields', is_array($d['recovery']) && array_keys($d['recovery']) === ['invalidated', 'tried', 'blocked']);
if (function_exists('opcache_invalidate')) {
    check('tried counts the served files', $d['recovery']['tried'] === $served);
} else {
    check('without opcache functions nothing is tried and nothing is blocked', $d['recovery'] === ['invalidated' => 0, 'tried' => 0, 'blocked' => false]);
}
$ini = ['enabled' => false];
check('opcache off is never "blocked"', lumen_probe_recover($r, $ini)['blocked'] === false);
if (function_exists('opcache_invalidate')) {
    $rc = lumen_probe_recover($r, ['enabled' => true]);
    check('enabled with zero successes out of tried files is blocked, with successes it is not',
        $rc['blocked'] === ($rc['tried'] > 0 && $rc['invalidated'] === 0));
}

echo "\na missing root never throws\n";
$d = lumen_probe_diagnose(sys_get_temp_dir() . '/lumen-probe-does-not-exist', '1.84.2', null, true);
check('verdict still returned', is_array($d) && in_array($d['cause'], ['not_written', 'opcache', 'incomplete', 'unknown'], true));

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
