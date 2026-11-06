<?php
/* First-run setup of the PHP backend (api/_admin_lib.php admin_setup_credential),
   twin of dev_server.py:_setup_credential.
   - The credential name only ever appears complete (temp sibling + hard link): a
     file created empty and filled afterwards locked the operator out when the
     write failed (setup refuses an existing file, login never matches).
   - Setup is create-exclusive: a second setup, or a file already there (even an
     empty one), is refused with 409 and left as it is.
   - A setup that cannot write answers 500 and leaves nothing behind.
   - A host that disables link() (an undefined function since PHP 8) still sets
     up through the create-exclusive write and leaves no temp file.
     php tests/test_admin_setup_credential_php.php                                  */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-setup-test-' . bin2hex(random_bytes(4));
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
function temp_leftovers(string $dir): array {
    return array_values(array_filter(scandir($dir) ?: [], fn($n) => strncmp($n, '.tmp-', 5) === 0));
}

/** Run admin_setup_credential in a child PHP process whose credential is $credPath. */
function child_setup(string $root, string $credPath, array $ini = []): ?array {
    $lib = str_replace('\\', '/', (string)realpath(__DIR__ . '/../api/_admin_lib.php'));
    $f = $root . '/child-' . bin2hex(random_bytes(4)) . '.php';
    file_put_contents($f, "<?php\ndeclare(strict_types=1);\n"
        . "define('LUMEN_PRIVATE_DIR', " . var_export($root, true) . ");\n"
        . "define('LUMEN_CRED_FILE', " . var_export($credPath, true) . ");\n"
        . "require_once " . var_export($lib, true) . ";\n"
        . "try { echo json_encode(admin_setup_credential('admin', 'correct horse battery')); }\n"
        . "catch (\\Throwable \$e) { echo json_encode([false, 'threw', get_class(\$e) . ': ' . \$e->getMessage()]); }\n");
    $flags = '';
    foreach ($ini as $k => $v) $flags .= ' -d ' . escapeshellarg($k . '=' . $v);
    $out = shell_exec(escapeshellarg(PHP_BINARY) . $flags . ' ' . escapeshellarg($f));
    @unlink($f);
    $d = is_string($out) ? json_decode(trim($out), true) : null;
    return is_array($d) ? $d : null;
}

$cred = LUMEN_CRED_FILE;

echo "weak password\n";
[$ok, $code, $body] = admin_setup_credential('admin', 'short');
check('refused with 400 weak_password', !$ok && $code === 400 && ($body['error'] ?? null) === 'weak_password');
check('nothing written', !file_exists($cred) && temp_leftovers($root) === []);

echo "\nfirst setup\n";
[$ok, $code, $body] = admin_setup_credential('  curator ', 'correct horse battery');
check('answers 200 ok with the trimmed user name', $ok && $code === 200 && ($body['ok'] ?? null) === true && ($body['username'] ?? null) === 'curator');
$raw = (string)@file_get_contents($cred);
$rec = json_decode($raw, true);
check('the credential is complete JSON', is_array($rec) && ($rec['version'] ?? null) === 1 && ($rec['username'] ?? null) === 'curator');
check('the stored hash verifies the password', is_array($rec) && admin_verify_password('correct horse battery', (string)($rec['password_pbkdf2'] ?? '')));
check('admin_credential() reads it back', (admin_credential()['username'] ?? null) === 'curator');
check('no temp file is left behind', temp_leftovers($root) === []);

echo "\nsecond setup\n";
[$ok, $code, $body] = admin_setup_credential('intruder', 'another long password');
check('refused with 409 already_configured', !$ok && $code === 409 && ($body['error'] ?? null) === 'already_configured');
check('the live credential is untouched', file_get_contents($cred) === $raw);
check('no temp file is left behind', temp_leftovers($root) === []);

echo "\na file already there, even empty\n";
@unlink($cred);
file_put_contents($cred, '');
[$ok, $code, $body] = admin_setup_credential('admin', 'correct horse battery');
check('refused with 409 already_configured', !$ok && $code === 409 && ($body['error'] ?? null) === 'already_configured');
check('the file is left as it is', file_get_contents($cred) === '');

echo "\na setup that cannot write\n";
file_put_contents("$root/blocker", 'a file where the credential folder should be');
$r = child_setup($root, "$root/blocker/cred.json");
if ($r === null) {
    echo "SKIP the unwritable case: no child PHP process could be started\n";
} else {
    check('answers 500 setup_failed', ($r[0] ?? null) === false && ($r[1] ?? null) === 500 && (($r[2]['error'] ?? null) === 'setup_failed'));
    check('no credential appears', !file_exists("$root/blocker/cred.json"));
}

echo "\na fresh folder\n";
$r = child_setup($root, "$root/fresh/sub/cred.json");
if ($r === null) {
    echo "SKIP the fresh-folder case: no child PHP process could be started\n";
} else {
    check('the folder is created and setup succeeds', ($r[0] ?? null) === true && ($r[1] ?? null) === 200);
    $fresh = json_decode((string)@file_get_contents("$root/fresh/sub/cred.json"), true);
    check('the credential there is complete', is_array($fresh) && ($fresh['username'] ?? null) === 'admin');
    check('no temp file is left behind there', temp_leftovers("$root/fresh/sub") === []);
}

echo "\nlink() disabled by the host (disable_functions)\n";
@mkdir("$root/nolink", 0777, true);
$r = child_setup($root, "$root/nolink/cred.json", ['disable_functions' => 'link']);
if ($r === null) {
    echo "SKIP the disabled-link case: no child PHP process could be started\n";
} else {
    check('setup succeeds through the create-exclusive write', ($r[0] ?? null) === true && ($r[1] ?? null) === 200);
    $nolink = json_decode((string)@file_get_contents("$root/nolink/cred.json"), true);
    check('the credential there is complete', is_array($nolink) && ($nolink['username'] ?? null) === 'admin');
    check('no temp file is left behind there', temp_leftovers("$root/nolink") === []);
    $again = child_setup($root, "$root/nolink/cred.json", ['disable_functions' => 'link']);
    check('a second setup is refused with 409', is_array($again) && ($again[0] ?? null) === false && ($again[1] ?? null) === 409);
    check('still no temp file left behind', temp_leftovers("$root/nolink") === []);
}

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
