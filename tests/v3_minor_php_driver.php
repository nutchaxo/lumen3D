<?php
/* Generic PHP twin driver for the tests/test_v3_minor_*.py parity tests.

     php tests/v3_minor_php_driver.php <web-root> <lib.php> [<lib.php> …]  < ops.json

   <web-root>/api/<lib.php> are required (copies made by the Python test, so
   admin_root() is the throwaway root). stdin is a JSON list of operations:
     {"fn": "<function>", "args": [...]}         call a function, result echoed
     {"server": {...}}                           merge into $_SERVER
   An argument {"__hex": "…"} is passed as the decoded binary string; a result
   string that is not valid UTF-8 comes back as {"__hex": "…"}. Output: one JSON
   list with one entry per op ({"ok": result} or {"error": message}). */
declare(strict_types=1);

$root = $argv[1] ?? '';
if ($root === '' || !is_dir($root)) { fwrite(STDERR, "no root\n"); exit(2); }
for ($i = 2; $i < $argc; $i++) {
    // --define=NAME defines a constant (value 1) before the next library loads,
    // e.g. LUMEN_DATASETS_LIB so api/datasets.php loads as a library.
    if (strncmp($argv[$i], '--define=', 9) === 0) { define(substr($argv[$i], 9), 1); continue; }
    require_once $root . '/api/' . $argv[$i];
}

function v3_decode($a) {
    if (is_array($a)) {
        if (count($a) === 1 && array_key_exists('__hex', $a)) return hex2bin((string)$a['__hex']);
        return array_map('v3_decode', $a);
    }
    return $a;
}

function v3_encode($r) {
    if (is_string($r)) return preg_match('//u', $r) ? $r : ['__hex' => bin2hex($r)];
    if (is_array($r)) return array_map('v3_encode', $r);
    return $r;
}

$ops = json_decode((string)stream_get_contents(STDIN), true);
$out = [];
foreach (is_array($ops) ? $ops : [] as $op) {
    try {
        if (isset($op['server']) && is_array($op['server'])) {
            foreach ($op['server'] as $k => $v) $_SERVER[$k] = $v;
            $out[] = ['ok' => true];
            continue;
        }
        $out[] = ['ok' => v3_encode(call_user_func_array((string)$op['fn'], v3_decode($op['args'] ?? [])))];
    } catch (Throwable $e) {
        $out[] = ['error' => get_class($e) . ': ' . $e->getMessage()];
    }
}
echo json_encode($out, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
