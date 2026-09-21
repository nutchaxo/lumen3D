<?php
/* PHP serialises every request of one session on the session file's lock, from
   session_start() to the end of the script (or session_write_close()). An admin
   action that waits on GitHub — update_check, marketplace_catalog, pipeline_info —
   therefore held the Datasets list and the click on a dataset for as long as GitHub
   took. The entry points that only READ the session (auth, CSRF) release the lock
   right after opening it; auth.php keeps it, its login writes the session.
     php tests/test_session_release_php.php                                        */
declare(strict_types=1);

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) $fails++;
}

$api = __DIR__ . '/../api';
foreach (['admin.php', 'datasets.php', 'site.php', 'media.php', 'upload.php'] as $f) {
    $src = (string)file_get_contents("$api/$f");
    $start = strpos($src, 'admin_session_start();');
    $close = strpos($src, 'session_write_close();');
    check("$f releases the session lock", $close !== false);
    check("$f releases it after the session was opened", $start !== false && $close !== false && $close > $start);
    $dispatch = strpos($src, 'switch ($action)');
    if ($dispatch !== false) check("$f releases it before dispatching the action", $close !== false && $close < $dispatch);
}
$auth = (string)file_get_contents("$api/auth.php");
check('auth.php keeps its session open (login writes to it)', strpos($auth, 'session_write_close()') === false);
check('auth.php is where the csrf token is minted (it must be persisted)', strpos($auth, 'admin_csrf()') !== false);
foreach (['admin.php', 'datasets.php', 'site.php', 'media.php'] as $f) {
    $src = (string)file_get_contents("$api/$f");
    check("$f never mints a csrf token after the lock is released", strpos($src, 'admin_csrf()') === false);
}

// The assumption everything rests on: $_SESSION stays readable once the lock is released.
$dir = sys_get_temp_dir() . '/lumen-sess-' . bin2hex(random_bytes(4));
@mkdir($dir, 0777, true);
session_save_path($dir);
ini_set('session.use_cookies', '0');
session_id('t' . bin2hex(random_bytes(6)));
session_start();
$_SESSION['admin_authenticated'] = true;
$_SESSION['csrf'] = 'abc';
session_write_close();
check('$_SESSION is still readable once the lock is released', !empty($_SESSION['admin_authenticated']) && ($_SESSION['csrf'] ?? null) === 'abc');
check('the session is no longer active (its lock is gone)', session_status() !== PHP_SESSION_ACTIVE);
foreach (glob("$dir/*") ?: [] as $p) @unlink($p);
@rmdir($dir);

echo $fails ? "FAILED ($fails)\n" : "OK\n";
exit($fails ? 1 : 0);
