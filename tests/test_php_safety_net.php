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
$errLog = "$root/php-error.log";
/** Start `php -S` on a free port: [process, port, up]. */
function start_server(string $root, string $errLog, string $tag): array {
    $sock = stream_socket_server('tcp://127.0.0.1:0', $en, $es);
    $name = (string)stream_socket_get_name($sock, false);
    $port = (int)substr($name, strrpos($name, ':') + 1);
    fclose($sock);
    $cmd = [PHP_BINARY, '-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1',
            '-d', 'log_errors=0', '-d', "error_log=$errLog", '-S', "127.0.0.1:$port", '-t', $root];
    $proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', "$root/server-$tag.out", 'w'], 2 => ['file', "$root/server-$tag.err", 'w']], $pipes);
    $up = false;
    for ($i = 0; $i < 100 && is_resource($proc); $i++) {
        $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2);
        if ($c) { fclose($c); $up = true; break; }
        usleep(100000);
    }
    return [$proc, $port, $up];
}
function stop_server($proc): void {
    if (is_resource($proc)) { proc_terminate($proc); proc_close($proc); }
}
[$proc, $port, $up] = start_server($root, $errLog, 'main');
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

    [$st, $h, $b] = fetch($port, '/api/twice.php');
    check('the prelude can be included repeatedly', $st === 200 && $b === '{"ok":true}', "$st $b");

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

// ── Memory fatals, each on a server of its own ──────────────────────────────
// deb.sury.org's PHP 8.1.34 (what setup-php installs on the CI runner) ends an out-of-memory
// fatal without running any shutdown function, so its `php -S` drops the connection or exits
// and no PHP code can answer; the official builds, sury's 8.3, PHP-FPM and mod_php run the
// fatal pass. Each case gets a server of its own so such a crash cannot take the other checks
// with it. When the server gave no answer, the same script runs through the CLI with the net
// forced on (LUMEN_SAFETY_NET_FORCE, JSON mode), where the fatal pass prints exactly what the
// HTTP client would have received; on a build that skips shutdown functions only the absence
// of a leak can be checked, and the run says so.
/** The body a memory-fatal script prints through the CLI with the safety net forced on. */
function cli_body(string $root, string $rel): array {
    $script = "<?php
define('LUMEN_SAFETY_NET_FORCE', true);
define('LUMEN_SAFETY_NET_MODE', 'json');
"
        . "require '" . addslashes("$root/$rel") . "';
";
    $file = "$root/cli-" . md5($rel) . '.php';
    file_put_contents($file, $script);
    $proc = proc_open([PHP_BINARY, '-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'log_errors=0', $file],
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    fclose($pipes[0]);
    $out = (string)stream_get_contents($pipes[1]);
    fclose($pipes[1]); fclose($pipes[2]);
    $code = proc_close($proc);
    return [$code, $out];
}
// Whether this PHP runs shutdown functions after an out-of-memory fatal at all (the official
// builds and deb.sury.org 8.3 do; deb.sury.org 8.1.34 exits at once), probed without the prelude.
$probe = proc_open([PHP_BINARY, '-n', '-d', 'display_errors=0', '-r',
    'register_shutdown_function(function () { echo "SD"; }); ini_set("memory_limit", "8M"); $x = str_repeat("x", 64 << 20);'],
    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pp);
fclose($pp[0]);
$oomRunsShutdown = trim((string)stream_get_contents($pp[1])) === 'SD';
fclose($pp[1]); fclose($pp[2]); proc_close($probe);

$memoryCases = [
    ['/api/fatal.php', 'api/fatal.php', 'fatal (memory): {"error":"internal_error"}', '{"error":"internal_error"}', 500],
    ['/api/answered.php', 'api/answered.php', 'an endpoint that answered its own fatal is not overridden', '{"own":true}', null],
];
foreach ($memoryCases as $i => [$path, $rel, $label, $want, $wantStatus]) {
    [$mp, $mport, $mup] = start_server($root, $errLog, "mem$i");
    if (!$mup) { check("$label: php -S started", false); stop_server($mp); continue; }
    [$st, $h, $b] = fetch($mport, $path);
    $alive = is_resource($mp) && (proc_get_status($mp)['running'] ?? false);
    stop_server($mp);
    if ($st !== 0) {
        check("$label (HTTP)", $b === $want && ($wantStatus === null || $st === $wantStatus), "$st $b");
    } else {
        echo "  note this php -S " . ($alive ? 'dropped the connection' : 'exited') . " on a memory fatal; proven through the CLI
";
        [$code, $out] = cli_body($root, $rel);
        if ($out === '' && !$oomRunsShutdown) {
            echo "  note this PHP build ends an out-of-memory fatal without running any shutdown function"
                . " (seen on deb.sury.org 8.1.34); no PHP code can answer it, only the absence of a leak is checked\n";
        } else {
            check("$label (CLI, net forced)", $out === $want, "exit $code: " . substr($out, 0, 200));
        }
        check("$label (CLI): no path or message in the body", strpos($out, $root) === false && stripos($out, 'Allowed memory') === false, $out);
    }
}

// ── cleanup ─────────────────────────────────────────────────────────────────
stop_server($proc);
if ($canLock) @chmod("$dl/locked", 0755);
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $f) { $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
@rmdir($root);

echo $fails ? "FAILED ($fails)\n" : "OK\n";
exit($fails ? 1 : 0);
