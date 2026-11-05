<?php
/**
 * api/_bootstrap.php — the PHP error safety net, proven with real HTTP answers of `php -S`.
 *
 * What a host with display_errors=On used to do: a warning landed inside a JSON body (the admin
 * showed "unable to load"), a TypeError / fatal answered an EMPTY 500. With the prelude a warning
 * never reaches the client, and an uncaught exception or a fatal answers {"error":"internal_error"}
 * without a path or message. Also: api/downloads.php answers a file name that is not valid UTF-8.
 *
 * Run: php tests/test_php_safety_net.php
 */
declare(strict_types=1);

$fails = 0;
function check(string $name, bool $cond, string $detail = ''): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . $name . (!$cond && $detail !== '' ? "  [$detail]" : '') . "\n";
    if (!$cond) $fails++;
}

$repo = dirname(__DIR__);
$api  = $repo . '/api';

// Every entry point loads the prelude (the files that only declare functions do not).
$entryPoints = ['admin', 'auth', 'catalog', 'datasets', 'download', 'downloads', 'integrity', 'languages',
    'media', 'migrations', 'plugins', 'site', 'telemetry', 'upload'];
foreach ($entryPoints as $e) {
    check("api/$e.php requires the safety net", strpos((string)file_get_contents("$api/$e.php"), "require_once __DIR__ . '/_bootstrap.php'") !== false);
}
foreach (['_serve.php', 'router.php'] as $e) {
    check("$e requires the safety net", strpos((string)file_get_contents("$repo/$e"), 'api/_bootstrap.php') !== false);
}

// ── Scratch document root ───────────────────────────────────────────────────
$root = sys_get_temp_dir() . '/lumen-net-' . bin2hex(random_bytes(4));
mkdir("$root/api", 0777, true);
copy("$api/_bootstrap.php", "$root/api/_bootstrap.php");
copy("$api/_admin_lib.php", "$root/api/_admin_lib.php");
copy("$api/downloads.php", "$root/api/downloads.php");

$pre = "<?php\nrequire_once __DIR__ . '/_bootstrap.php';\n";
$files = [
    // A warning (a notice before 8.0) and a deprecation inside a JSON answer.
    'api/warn.php' => $pre . "header('Content-Type: application/json');\n\$a = [];\necho json_encode(['v' => \$a['missing'], 'n' => strlen(null)]);\n",
    // Same code, no prelude: proves display_errors=1 really corrupts the body.
    'api/control.php' => "<?php\nheader('Content-Type: application/json');\n\$a = [];\necho json_encode(['v' => \$a['missing']]);\n",
    // @ keeps meaning what it meant.
    'api/suppressed.php' => $pre . "header('Content-Type: application/json');\n\$a = [];\necho json_encode(['v' => @\$a['missing']]);\n",
    'api/boom.php' => $pre . "header('Content-Type: application/json');\nthrow new RuntimeException('secret-token /etc/passwd');\n",
    'api/typeerror.php' => "<?php\ndeclare(strict_types=1);\nrequire_once __DIR__ . '/_bootstrap.php';\nfunction f(int \$x) { return \$x; }\nf('not an int');\n",
    'api/fatal.php' => $pre . "ini_set('memory_limit', '8M');\n\$x = str_repeat('x', 64 * 1024 * 1024);\necho 'unreachable';\n",
    'api/twice.php' => $pre . "require_once __DIR__ . '/_bootstrap.php';\nrequire __DIR__ . '/_bootstrap.php';\nheader('Content-Type: application/json');\necho '{\"ok\":true}';\n",
    // An endpoint with its own fatal answer (api/integrity.php) is not overridden.
    'api/answered.php' => $pre . "register_shutdown_function(function () {\n"
        . "    \$GLOBALS['lumen_fatal_answered'] = true;\n    while (ob_get_level() > 0) @ob_end_clean();\n"
        . "    http_response_code(200);\n    header('Content-Type: application/json');\n    echo '{\"own\":true}';\n});\n"
        . "ini_set('memory_limit', '8M');\n\$x = str_repeat('x', 64 * 1024 * 1024);\n",
    // Bytes already sent: the response is left alone.
    'api/partial.php' => $pre . "header('Content-Type: text/plain');\necho 'partial-body';\nflush();\nthrow new Exception('late');\n",
    // An HTML page gets a plain error page, not JSON.
    'page.php' => "<?php\nrequire_once __DIR__ . '/api/_bootstrap.php';\nheader('Content-Type: text/html');\nthrow new LogicException('page failure');\n",
];
foreach ($files as $rel => $src) file_put_contents("$root/$rel", $src);

// api/downloads.php over a tree with a file name that is not valid UTF-8.
$dl = "$root/DATA_WEB/3d/ds/download";
mkdir($dl, 0777, true);
file_put_contents("$dl/ok.txt", 'x');
$badName = "bad-\xFF\xFE-name.txt";
$canMakeBad = @file_put_contents("$dl/$badName", 'x') !== false && is_file("$dl/$badName");
$canLock = DIRECTORY_SEPARATOR === '/' && function_exists('posix_geteuid') && posix_geteuid() !== 0;
if ($canLock) { mkdir("$dl/locked"); chmod("$dl/locked", 0000); }

// ── php -S ──────────────────────────────────────────────────────────────────
$sock = stream_socket_server('tcp://127.0.0.1:0', $en, $es);
$port = (int)substr((string)stream_socket_get_name($sock, false), strrpos((string)stream_socket_get_name($sock, false), ':') + 1);
fclose($sock);
$errLog = "$root/php-error.log";
$cmd = [PHP_BINARY, '-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1',
        '-d', 'log_errors=0', '-d', "error_log=$errLog", '-S', "127.0.0.1:$port", '-t', $root];
$proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', "$root/server.out", 'w'], 2 => ['file', "$root/server.err", 'w']], $pipes);
$up = false;
for ($i = 0; $i < 100 && is_resource($proc); $i++) {
    $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2);
    if ($c) { fclose($c); $up = true; break; }
    usleep(100000);
}
check('php -S started', $up);

/** [status, headers (lower-cased name => value), body] */
function fetch(int $port, string $path): array {
    $ctx = stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 20]]);
    $body = @file_get_contents("http://127.0.0.1:$port$path", false, $ctx);
    $status = 0; $headers = [];
    foreach (($http_response_header ?? []) as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) { $status = (int)$m[1]; continue; }
        $p = strpos($h, ':');
        if ($p !== false) $headers[strtolower(substr($h, 0, $p))] = trim(substr($h, $p + 1));
    }
    return [$status, $headers, (string)$body];
}

if ($up) {
    [$st, $h, $b] = fetch($port, '/api/control.php');
    check('control: without the prelude a warning corrupts the JSON (display_errors=1)', json_decode($b, true) === null && stripos($b, 'Undefined') !== false, $b);

    [$st, $h, $b] = fetch($port, '/api/warn.php');
    $j = json_decode($b, true);
    check('warning + deprecation: status 200', $st === 200, (string)$st);
    check('warning + deprecation: body is still valid JSON', is_array($j) && array_key_exists('v', $j), $b);
    check('warning + deprecation: no message in the body', stripos($b, 'Warning') === false && stripos($b, 'Notice') === false && stripos($b, 'Deprecated') === false, $b);

    [$st, $h, $b] = fetch($port, '/api/suppressed.php');
    check('@-suppression semantics are unchanged', $st === 200 && json_decode($b, true) === ['v' => null], $b);

    [$st, $h, $b] = fetch($port, '/api/boom.php');
    check('uncaught exception: HTTP 500', $st === 500, (string)$st);
    check('uncaught exception: clean JSON body', $b === '{"error":"internal_error"}', $b);
    check('uncaught exception: JSON content type', stripos($h['content-type'] ?? '', 'application/json') === 0, $h['content-type'] ?? '');
    check('uncaught exception: nothing leaks to the client', stripos($b, 'secret') === false && stripos($b, 'passwd') === false && stripos($b, 'boom.php') === false);

    [$st, $h, $b] = fetch($port, '/api/typeerror.php');
    check('TypeError: HTTP 500 {"error":"internal_error"}', $st === 500 && $b === '{"error":"internal_error"}', "$st $b");

    [$st, $h, $b] = fetch($port, '/api/fatal.php');
    check('fatal (memory): HTTP 500 {"error":"internal_error"}', $st === 500 && $b === '{"error":"internal_error"}', "$st $b");

    [$st, $h, $b] = fetch($port, '/api/twice.php');
    check('the prelude can be included repeatedly', $st === 200 && $b === '{"ok":true}', "$st $b");

    [$st, $h, $b] = fetch($port, '/api/answered.php');
    check('an endpoint that answered its own fatal is not overridden', $b === '{"own":true}', "$st $b");

    [$st, $h, $b] = fetch($port, '/api/partial.php');
    check('bytes already sent: the response is left alone', $b === 'partial-body', "$st $b");

    [$st, $h, $b] = fetch($port, '/page.php');
    check('HTML page: HTTP 500', $st === 500, (string)$st);
    check('HTML page: plain text error, no JSON, no detail', $b === 'Internal Server Error' && stripos($h['content-type'] ?? '', 'text/plain') === 0, $b);

    // api/downloads.php — the shipped endpoint
    [$st, $h, $b] = fetch($port, '/api/downloads.php?dataset=' . rawurlencode('3d/ds'));
    $j = json_decode($b, true);
    check('downloads: listing is valid JSON with display_errors=1', $st === 200 && is_array($j) && !empty($j['available']), "$st " . substr($b, 0, 200));
    $names = is_array($j) ? array_column($j['entries'] ?? [], 'name') : [];
    check('downloads: the plain file is listed', in_array('ok.txt', $names, true), $b);
    if ($canMakeBad) {
        check('downloads: a non-UTF-8 file name does not empty the answer', $b !== '' && count($names) >= 2, substr($b, 0, 200));
    } else {
        echo "SKIP downloads: this file system refuses a non-UTF-8 file name\n";
    }
    if ($canLock) {
        check('downloads: an unreadable sub-folder is listed (count 0), no warning in the body',
            is_array($j) && in_array('locked', $names, true) && stripos($b, 'Warning') === false, $b);
    }
}

// ── cleanup ─────────────────────────────────────────────────────────────────
if (is_resource($proc)) { proc_terminate($proc); proc_close($proc); }
if ($canLock) @chmod("$dl/locked", 0755);
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $f) { $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
@rmdir($root);

echo $fails ? "FAILED ($fails)\n" : "OK\n";
exit($fails ? 1 : 0);
