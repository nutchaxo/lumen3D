<?php
/* Login throttling and credential checks of the PHP backend (api/_admin_lib.php).
   - A burst of parallel attempts gets exactly the budget, no more: the attempt is
     reserved under a lock BEFORE the hash runs (the old check-then-hash let every
     request of a burst through).
   - The lockout store fails CLOSED when it cannot be written.
   - An unknown username costs the same PBKDF2 as a known one (no timing oracle).
   - A legacy unsalted sha256 credential is upgraded at login, then refused elsewhere.
   - Forwarded headers count only behind a declared proxy; login CSRF guard.
     php tests/test_php_bruteforce.php                                              */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-bf-test-' . bin2hex(random_bytes(4));
@mkdir($root, 0777, true);
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_CRED_FILE', $root . '/cred.json');
require_once __DIR__ . '/../api/_admin_lib.php';

function rrm(string $d): void {
    if (!is_dir($d)) { @unlink($d); return; }
    foreach (scandir($d) ?: [] as $f) { if ($f !== '.' && $f !== '..') rrm("$d/$f"); }
    @rmdir($d);
}
register_shutdown_function(function () use ($root) { rrm($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

/** A child PHP process with the same isolation constants; prints JSON. */
function child_script(string $root, string $body, string $privateDir = ''): string {
    $lib = str_replace('\\', '/', (string)realpath(__DIR__ . '/../api/_admin_lib.php'));
    $pd  = $privateDir !== '' ? $privateDir : $root;
    $f = $root . '/child-' . bin2hex(random_bytes(4)) . '.php';
    file_put_contents($f, "<?php\ndeclare(strict_types=1);\n"
        . "define('LUMEN_PRIVATE_DIR', " . var_export($pd, true) . ");\n"
        . "define('LUMEN_CRED_FILE', " . var_export($root . '/cred.json', true) . ");\n"
        . "require " . var_export($lib, true) . ";\n" . $body);
    return $f;
}

echo "parallel burst from one address\n";
$go = $root . '/go';
$child = child_script($root, '$_SERVER["REMOTE_ADDR"] = $argv[1];'
    . 'while (!is_file($argv[2])) usleep(2000);'
    . 'echo json_encode(admin_bf_reserve());');
$procs = [];
for ($i = 0; $i < 30; $i++) {
    $p = proc_open([PHP_BINARY, $child, '203.0.113.7', $go], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $procs[] = [$p, $pipes];
}
usleep(400000);
touch($go);                                     // release all 30 at once
$allowed = 0; $locked = 0;
foreach ($procs as [$p, $pipes]) {
    $out = json_decode((string)stream_get_contents($pipes[1]), true);
    fclose($pipes[1]); fclose($pipes[2]); proc_close($p);
    if (is_array($out) && $out[0] === true) $allowed++;
    elseif (is_array($out) && ($out[2] ?? null) === 'locked') $locked++;
}
check("30 simultaneous attempts → exactly " . ADMIN_BF_MAX_ATTEMPTS . " allowed (got $allowed)", $allowed === ADMIN_BF_MAX_ATTEMPTS);
check('the rest are refused as locked', $locked === 30 - ADMIN_BF_MAX_ATTEMPTS);

$_SERVER['REMOTE_ADDR'] = '203.0.113.7';
[$ok, $retry] = admin_bf_reserve();
check('the address stays locked afterwards, with a retry delay', !$ok && $retry > 0 && $retry <= ADMIN_BF_LOCK);
$_SERVER['REMOTE_ADDR'] = '198.51.100.1';
check('another address is not affected', admin_bf_reserve()[0] === true);
admin_bf_success();
$_SERVER['REMOTE_ADDR'] = '198.51.100.2';
for ($i = 0; $i < ADMIN_BF_MAX_ATTEMPTS - 1; $i++) admin_bf_reserve();
admin_bf_success();
check('a success resets the address budget', admin_bf_reserve()[0] === true);
admin_bf_success();

echo "\nglobal ceiling\n";
$refusedGlobal = false;
for ($i = 0; $i < ADMIN_BF_GLOBAL_MAX + 5 && !$refusedGlobal; $i++) {
    $_SERVER['REMOTE_ADDR'] = '10.9.' . intdiv($i, 250) . '.' . ($i % 250);
    $r = admin_bf_reserve();
    if (!$r[0] && $r[2] === 'global') $refusedGlobal = true;
}
check('attempts spread over many addresses hit the global ceiling', $refusedGlobal);

echo "\nfail closed\n";
file_put_contents($root . '/not-a-dir', 'x');
$c = child_script($root, '$_SERVER["REMOTE_ADDR"] = "192.0.2.1"; echo json_encode(admin_bf_reserve());', $root . '/not-a-dir');
$out = json_decode((string)shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($c)), true);
check('an unusable lockout store refuses the attempt (store_unavailable)',
    is_array($out) && $out[0] === false && ($out[2] ?? null) === 'store_unavailable');

echo "\ncredential checks\n";
file_put_contents(cred_file(), json_encode(admin_credential_record('lab', 'correct horse')));
check('right user + password logs in', admin_login_verify('lab', 'correct horse')[0] === true);
check('wrong password refused', admin_login_verify('lab', 'nope-nope')[0] === false);
check('unknown user refused', admin_login_verify('ghost', 'correct horse')[0] === false);
$t = function (string $u, string $p): float { $s = hrtime(true); admin_login_verify($u, $p); return (hrtime(true) - $s) / 1e6; };
$known = min($t('lab', 'x'), $t('lab', 'y'), $t('lab', 'z'));
$ghost = min($t('ghost', 'x'), $t('ghost', 'y'), $t('ghost', 'z'));
check(sprintf('an unknown user costs the same PBKDF2 (%.0f ms vs %.0f ms)', $ghost, $known),
    $ghost > $known * 0.5 && $ghost < $known * 2.0);

$stampBefore = admin_credential_stamp();
[$okc] = admin_change_credential('correct horse', 'battery staple');
check('a password change rotates the credential stamp (other sessions signed out)', $okc && admin_credential_stamp() !== $stampBefore);

file_put_contents(cred_file(), json_encode(['username' => 'lab', 'password_pbkdf2' => hash('sha256', 'legacy-pass')]));
check('a legacy sha256 hash is refused by the generic check', admin_verify_password('legacy-pass', hash('sha256', 'legacy-pass')) === false);
check('… and accepted once at login', admin_login_verify('lab', 'legacy-pass')[0] === true);
$rec = json_decode((string)file_get_contents(cred_file()), true);
check('… which rewrites it as PBKDF2', strncmp((string)$rec['password_pbkdf2'], 'pbkdf2_sha256$', 14) === 0
    && admin_verify_password('legacy-pass', $rec['password_pbkdf2']));

echo "\nsessions\n";
$_SESSION = ['admin_authenticated' => true, 'auth_at' => time(), 'cred_stamp' => admin_credential_stamp()];
check('a session under the current stamp is authenticated', admin_is_auth());
$_SESSION['auth_at'] = time() - ADMIN_SESSION_TTL - 1;
check('8 h after login it is not, whatever the activity', !admin_is_auth());
$_SESSION = ['admin_authenticated' => true, 'auth_at' => time(), 'cred_stamp' => 'stale'];
check('a session opened under an older password is not', !admin_is_auth());
$_SESSION = ['admin_authenticated' => true];
check('a session from before these rules (no stamp) is not', !admin_is_auth());

echo "\nclient address\n";
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '6.6.6.6';
check('X-Forwarded-For is ignored without a declared proxy', admin_client_ip() === '127.0.0.1');
unset($_SERVER['HTTP_X_FORWARDED_FOR']);
$c = child_script($root, 'putenv("LUMEN_TRUSTED_PROXIES=10.0.0.0/8 127.0.0.1");'
    . '$_SERVER["REMOTE_ADDR"] = "127.0.0.1"; $_SERVER["HTTP_X_FORWARDED_FOR"] = "6.6.6.6, 203.0.113.9, 10.1.2.3";'
    . '$_SERVER["HTTP_X_FORWARDED_PROTO"] = "https";'
    . 'echo json_encode([admin_client_ip(), admin_request_is_https()]);');
$out = json_decode((string)shell_exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($c)), true);
check('behind a declared proxy: the right-most untrusted hop is the client', is_array($out) && $out[0] === '203.0.113.9');
check('… and X-Forwarded-Proto https marks the cookie Secure', is_array($out) && $out[1] === true);
check('IPv6 CIDR matching', admin_ip_in_cidr('2001:db8::5', '2001:db8::/32') && !admin_ip_in_cidr('2001:db9::5', '2001:db8::/32'));

echo "\nlogin CSRF guard\n";
$_SERVER = ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_HOST' => 'lab.example', 'CONTENT_TYPE' => 'application/json'];
check('same-origin JSON without Origin passes', admin_same_origin_json());
$_SERVER['HTTP_ORIGIN'] = 'https://lab.example';
check('matching Origin passes', admin_same_origin_json());
$_SERVER['HTTP_ORIGIN'] = 'https://evil.example';
check('foreign Origin refused', !admin_same_origin_json());
$_SERVER['HTTP_ORIGIN'] = 'https://lab.example';
$_SERVER['CONTENT_TYPE'] = 'text/plain;charset=UTF-8';
check('text/plain (a no-cors cross-site post) refused', !admin_same_origin_json());
$_SERVER['CONTENT_TYPE'] = 'application/json';
$_SERVER['HTTP_SEC_FETCH_SITE'] = 'cross-site';
check('Sec-Fetch-Site: cross-site refused', !admin_same_origin_json());
$_SERVER['HTTP_SEC_FETCH_SITE'] = 'same-origin';
$_SERVER['HTTP_HOST'] = '127.0.0.1:8081';          // a proxy that rewrites Host, not declared
check('Sec-Fetch-Site: same-origin decides (Host rewritten by a proxy)', admin_same_origin_json());
unset($_SERVER['HTTP_SEC_FETCH_SITE']);
check('… without Sec-Fetch-Site the Origin/Host comparison still applies', !admin_same_origin_json());

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
