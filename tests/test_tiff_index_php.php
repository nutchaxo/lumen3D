<?php
/**
 * api/tiff-index.php — the PHP twin of dev_server.py's /api/tiff-index, over real HTTP (`php -S`) in a
 * scratch document root (never the checkout's DATA_WEB), on the synthetic TIFFs of
 * tests/tiff_index_fixtures.py. Parity: the Python helper runs on the same files and the two JSON
 * documents must be byte-identical.
 *
 * Needs `python` (the fixtures are written by tests/tiff_index_fixtures.py). Run: php tests/test_tiff_index_php.php
 */
$fails = 0;
function check(string $name, bool $cond, string $detail = ''): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . $name . (!$cond && $detail !== '' ? "  [$detail]" : '') . "\n";
    if (!$cond) $fails++;
}

$repo = dirname(__DIR__);

/** First python launcher that runs. */
function find_python(): ?string {
    foreach (['python', 'python3', 'py'] as $c) {
        $p = @proc_open([$c, '-c', 'print(1)'], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($p)) continue;
        $out = trim((string)stream_get_contents($pipes[1]));
        fclose($pipes[1]); fclose($pipes[2]);
        if (proc_close($p) === 0 && $out === '1') return $c;
    }
    return null;
}
function run(array $cmd): array {
    $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $out = (string)stream_get_contents($pipes[1]);
    $err = (string)stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    return [proc_close($p), $out, $err];
}

$python = find_python();
if ($python === null) { echo "SKIP no python on PATH: the TIFF fixtures cannot be written\n"; exit(0); }

$root = sys_get_temp_dir() . '/lumen-tiff-' . bin2hex(random_bytes(4));
mkdir("$root/api", 0777, true);
foreach (['_bootstrap.php', '_admin_lib.php', 'tiff-index.php'] as $f) copy("$repo/api/$f", "$root/api/$f");
foreach (['3d/demo' => false, '3d/secret' => true] as $ds => $hidden) {
    $dl = "$root/DATA_WEB/$ds/download";
    mkdir("$dl/sub", 0777, true);
    file_put_contents("$root/DATA_WEB/$ds/metadata.json", json_encode(['hidden' => $hidden]));
    [$code, , $err] = run([$python, '-I', "$repo/tests/tiff_index_fixtures.py", $dl]);
    check("fixtures written for $ds", $code === 0, $err);
    copy("$dl/ij-ii.tif", "$dl/sub/deep.tif");
    copy("$dl/ij-ii.tif", "$dl/spaced name.tif");
    file_put_contents("$dl/notes.txt", 'x');
}
copy("$root/DATA_WEB/3d/demo/download/ij-ii.tif", "$root/DATA_WEB/outside.tif");
$expect = json_decode((string)file_get_contents("$root/DATA_WEB/3d/demo/download/expect.json"), true);

$sock = stream_socket_server('tcp://127.0.0.1:0', $en, $es);
$name = (string)stream_socket_get_name($sock, false);
$port = (int)substr($name, strrpos($name, ':') + 1);
fclose($sock);
$proc = proc_open([PHP_BINARY, '-d', 'display_errors=1', '-d', 'html_errors=0', '-d', 'error_reporting=-1', '-S', "127.0.0.1:$port", '-t', $root],
    [0 => ['pipe', 'r'], 1 => ['file', "$root/server.out", 'w'], 2 => ['file', "$root/server.err", 'w']], $pipes);
$up = false;
for ($i = 0; $i < 100 && is_resource($proc); $i++) {
    $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2);
    if ($c) { fclose($c); $up = true; break; }
    usleep(100000);
}
check('php -S started', $up);

function fetch(int $port, string $query, array $headers = []): array {
    $h = '';
    foreach ($headers as $k => $v) $h .= "$k: $v\r\n";
    $ctx = stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 30, 'header' => $h]]);
    $body = @file_get_contents("http://127.0.0.1:$port/api/tiff-index.php?$query", false, $ctx);
    $status = 0; $out = [];
    foreach (($http_response_header ?? []) as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $status = (int)$m[1]; continue; }
        $p = strpos($line, ':');
        if ($p !== false) $out[strtolower(substr($line, 0, $p))] = trim(substr($line, $p + 1));
    }
    return [$status, $out, (string)$body];
}

if ($up) {
    // Every fixture, and byte parity with the Python twin.
    foreach ($expect as $file => $exp) {
        [$st, $h, $body] = fetch($port, 'dataset=3d/demo&file=' . rawurlencode($file));
        if (isset($exp['error'])) {
            $err = json_decode($body, true);
            check("$file: 422 {$exp['error']}", $st === 422 && ($err['error'] ?? null) === $exp['error'], "$st $body");
            continue;
        }
        $doc = json_decode($body, true);
        check("$file: answers {$exp['pages']} pages", $st === 200 && is_array($doc) && $doc['pages'] === $exp['pages'], "$st " . substr($body, 0, 120));
        // JSON strings are Python string literals only without PHP's escaped slashes ("\/" is not a Python escape: on Linux the path breaks)
        $lit = function ($v) { return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); };
        $code = "import sys; sys.path.insert(0, " . $lit($repo) . "); import dev_server as d; "
            . "sys.stdout.buffer.write(d._tiff_json(d._tiff_index(" . $lit("$root/DATA_WEB/3d/demo/download/$file") . ", '3d/demo', " . $lit($file) . ")).encode('utf-8'))";
        [$pc, $py, $perr] = run([$python, '-c', $code]);
        check("$file: JSON byte-identical to the Python twin", $pc === 0 && $py === $body, $pc === 0 ? 'differs at byte ' . strspn($py ^ $body, "\0") : substr($perr, -200));
    }

    [$st, $h, $body] = fetch($port, 'dataset=3d/demo&file=ij-ii.tif');
    check('etag has the documented shape', (bool)preg_match('/^"\d+-\d+-v1"$/', $h['etag'] ?? ''), $h['etag'] ?? '');
    check('no-cache, same-origin only', ($h['cache-control'] ?? '') === 'no-cache' && !isset($h['access-control-allow-origin']));
    [$st2, , $b2] = fetch($port, 'dataset=3d/demo&file=ij-ii.tif', ['If-None-Match' => $h['etag'] ?? '']);
    check('If-None-Match answers 304 without a body', $st2 === 304 && $b2 === '', "$st2");
    [$st3] = fetch($port, 'dataset=3d/demo&file=' . rawurlencode('spaced name.tif'));
    check('a file name with a space', $st3 === 200, "$st3");

    $cases = [
        'dataset=3d/demo&file=../../outside.tif' => [400, 'invalid_file'],
        'dataset=3d/demo&file=sub/deep.tif' => [400, 'invalid_file'],
        'dataset=3d/demo&file=..%2Foutside.tif' => [400, 'invalid_file'],
        'dataset=3d/demo&file=notes.txt' => [400, 'invalid_file'],
        'dataset=3d/demo&file=.hidden.tif' => [400, 'invalid_file'],
        'dataset=3d/demo&file=ij-ii.tif%00.png' => [400, 'invalid_file'],
        'dataset=3d/demo&file=ij-ii.tif%0A' => [400, 'invalid_file'],
        'dataset=3d/demo&file=' => [400, 'invalid_file'],
        'dataset=../etc&file=a.tif' => [400, 'invalid_dataset'],
        'dataset=3d/../2d&file=a.tif' => [400, 'invalid_dataset'],
        'dataset=fixed/demo&file=ij-ii.tif' => [400, 'invalid_dataset'],
        'dataset=3d&file=a.tif' => [400, 'invalid_dataset'],
        'dataset=3d/secret&file=ij-ii.tif' => [404, 'not_found'],
        'dataset=3d/ghost&file=ij-ii.tif' => [404, 'not_found'],
        'dataset=3d/demo&file=missing.tif' => [404, 'not_found'],
    ];
    foreach ($cases as $query => [$want, $code]) {
        [$st, , $body] = fetch($port, $query);
        $j = json_decode($body, true);
        check("refused: $query", $st === $want && ($j['error'] ?? null) === $code, "$st $body");
    }
    [$a, , $ba] = fetch($port, 'dataset=3d/secret&file=ij-ii.tif');
    [$b, , $bb] = fetch($port, 'dataset=3d/ghost&file=ij-ii.tif');
    check('a hidden dataset answers like an unknown one', $a === $b && $ba === $bb);
}

if (is_resource($proc)) { proc_terminate($proc); proc_close($proc); }
function rrmdir(string $d): void {
    if (!is_dir($d)) return;
    foreach (scandir($d) as $e) { if ($e === '.' || $e === '..') continue; $p = "$d/$e"; is_dir($p) ? rrmdir($p) : @unlink($p); }
    @rmdir($d);
}
rrmdir($root);
echo $fails === 0 ? "\nAll good.\n" : "\n$fails FAILED\n";
exit($fails === 0 ? 0 : 1);
