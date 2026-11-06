<?php
/* api/datasets.php must accept only a session admin_is_auth() accepts: one opened
   under the current password (credential stamp) and less than ADMIN_SESSION_TTL old.
   A password change on PHP signs the other sessions out only through that stamp —
   their `admin_authenticated` flag stays true — and a session still in use is never
   collected by PHP's GC, so a bare flag check kept a revoked or expired cookie able
   to list hidden datasets, edit, delete and empty the trash. Twin of dev_server.py
   _get_session, which gates the whole /api/datasets.php handler.

   Every request runs datasets.php for real in a child PHP process against a
   throwaway DATA_WEB, credential and session store.
     php tests/test_datasets_auth_php.php                                        */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-dsauth-' . bin2hex(random_bytes(4));
@mkdir($root . '/DATA_WEB/3d/demo', 0777, true);
define('LUMEN_PRIVATE_DIR', $root . '/private');
define('LUMEN_CRED_FILE', $root . '/cred.json');
define('LUMEN_DATA_WEB', $root . '/DATA_WEB');
@mkdir(LUMEN_PRIVATE_DIR . '/.sessions', 0700, true);
require_once __DIR__ . '/../api/_admin_lib.php';

function rrm(string $d): void {
    if (!is_dir($d)) return;
    foreach (scandir($d) ?: [] as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = "$d/$f";
        is_dir($p) ? rrm($p) : @unlink($p);
    }
    @rmdir($d);
}
register_shutdown_function(function () use ($root) { rrm($root); });

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

if (!function_exists('proc_open')) {
    echo "SKIP proc_open is disabled in this PHP build\n";
    exit(0);
}

$metaPath = $root . '/DATA_WEB/3d/demo/metadata.json';
file_put_contents($metaPath, json_encode([
    'id' => '3d/demo', 'type' => '3d', 'name' => 'Demo', 'hidden' => true,
    'dimensions' => ['x' => 64, 'y' => 64, 'z' => 32, 'c' => 1],
    'channels' => [['name' => 'DAPI']],
]));
file_put_contents(LUMEN_CRED_FILE, json_encode(admin_credential_record('admin', 'correct horse battery')));
$stamp = admin_credential_stamp();
check('the credential has a stamp', $stamp !== '');

// Session files are written straight into the store admin_session_start() in the
// child reads, in PHP's default `php` serialize_handler format (key|serialized).
function seed_session(array $data): string {
    $sid = 'dsauth' . bin2hex(random_bytes(8));
    $enc = '';
    foreach ($data as $k => $v) $enc .= $k . '|' . serialize($v);
    file_put_contents(LUMEN_PRIVATE_DIR . '/.sessions/sess_' . $sid, $enc);
    return $sid;
}

$child = $root . '/child.php';
file_put_contents($child, "<?php\n"
    . "define('LUMEN_PRIVATE_DIR', " . var_export(LUMEN_PRIVATE_DIR, true) . ");\n"
    . "define('LUMEN_CRED_FILE', " . var_export(LUMEN_CRED_FILE, true) . ");\n"
    . "define('LUMEN_DATA_WEB', " . var_export(LUMEN_DATA_WEB, true) . ");\n"
    . '[, $sid, $method, $action, $csrf] = $argv;' . "\n"
    . '$_SERVER["REQUEST_METHOD"] = $method;' . "\n"
    . '$_SERVER["REMOTE_ADDR"] = "127.0.0.1";' . "\n"
    . 'if ($csrf !== "") $_SERVER["HTTP_X_CSRF_TOKEN"] = $csrf;' . "\n"
    . '$_GET = ["action" => $action, "id" => "3d/demo"];' . "\n"
    . 'if ($sid !== "") session_id($sid);' . "\n"
    . 'register_shutdown_function(function () { echo "\n@@SESSION " . json_encode(!empty($_SESSION["admin_authenticated"]))'
    . ' . "\n@@STATUS " . (int)http_response_code() . "\n"; });' . "\n"
    . 'require ' . var_export(realpath(__DIR__ . '/../api/datasets.php'), true) . ";\n");

/** Run one datasets.php request; returns [status, decoded body, session flag seen]. */
function run_request(string $child, string $sid, string $method, string $action, string $csrf = ''): array {
    $p = proc_open([PHP_BINARY, $child, $sid, $method, $action, $csrf],
                   [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($p)) return [0, null];
    fclose($pipes[0]);
    $out = (string)stream_get_contents($pipes[1]);
    fclose($pipes[1]); fclose($pipes[2]); proc_close($p);
    $status = preg_match('/@@STATUS (\d+)\s*$/', $out, $m) ? (int)$m[1] : 0;
    $flag = preg_match('/@@SESSION (true|false)/', $out, $m) ? $m[1] === 'true' : null;
    $body = json_decode(trim((string)preg_replace('/@@SESSION .*$/s', '', $out)), true);
    return [$status, $body, $flag];
}

function hidden_flag(string $metaPath) {
    return (json_decode((string)file_get_contents($metaPath), true) ?: [])['hidden'] ?? null;
}

$now = time();
$sessions = [
    'stamp from before the password change' => [
        'admin_authenticated' => true, 'admin_user' => 'admin', 'auth_at' => $now,
        'cred_stamp' => str_repeat('0', 32), 'csrf' => 'tok-stale'],
    'older than the session lifetime' => [
        'admin_authenticated' => true, 'admin_user' => 'admin',
        'auth_at' => $now - ADMIN_SESSION_TTL - 1, 'cred_stamp' => $stamp, 'csrf' => 'tok-old'],
    'flag alone (no login time, no stamp)' => [
        'admin_authenticated' => true, 'csrf' => 'tok-flag'],
];

foreach ($sessions as $label => $data) {
    echo "\n$label\n";
    $sid = seed_session($data);
    [$st, $body, $flag] = run_request($child, $sid, 'GET', 'list');
    check('the child loaded the session (its admin_authenticated flag is set)', $flag === true);
    check('list is refused with 401', $st === 401);
    check('… and lists nothing', !is_array($body) || !isset($body[0]) && !isset($body['datasets']));
    [$st] = run_request($child, $sid, 'GET', 'get');
    check('get is refused with 401', $st === 401);
    [$st] = run_request($child, $sid, 'POST', 'set_visibility', $data['csrf']);
    check('set_visibility with the session\'s own csrf token is refused with 401', $st === 401);
    check('… and the dataset stays hidden', hidden_flag($metaPath) === true);
    [$st] = run_request($child, $sid, 'POST', 'trash_empty', $data['csrf']);
    check('trash_empty is refused with 401', $st === 401);
}

echo "\nno session at all\n";
[$st] = run_request($child, '', 'GET', 'list');
check('list without a session is refused with 401', $st === 401);

echo "\na session opened by a real login\n";
$sid = seed_session([
    'admin_authenticated' => true, 'admin_user' => 'admin', 'auth_at' => $now,
    'cred_stamp' => $stamp, 'csrf' => 'tok-good']);
[$st, $body] = run_request($child, $sid, 'GET', 'get');
check('get answers 200 with the metadata', $st === 200 && is_array($body) && ($body['name'] ?? null) === 'Demo');
[$st, $body] = run_request($child, $sid, 'POST', 'set_visibility', 'tok-good');
check('set_visibility answers 200', $st === 200 && ($body['ok'] ?? false) === true);
check('… and the write landed (empty body = visible)', hidden_flag($metaPath) === false);

echo $fails ? "\nFAILED ($fails)\n" : "\nOK\n";
exit($fails ? 1 : 0);
