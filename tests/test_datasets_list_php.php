<?php
/* The admin Datasets tab is ONE request: api/datasets.php?action=list, published
   datasets merged with the staged imports, encoded in one json_out(). Anything
   that throws or makes json_encode() fail inside that request blanks the whole
   tab on a PHP host — the Python dev server, which sorts and encodes
   differently, stays fine, so nothing in the Python suites catches it.

   This test feeds the list path the three shapes that were found to do exactly
   that, and asserts the answer is still a full, decodable list:
     - a metadata.json whose "name" is a number (strcmp under strict_types),
     - a dataset folder whose name is not valid UTF-8 (json_encode -> false),
     - an import journal whose entries are not objects (TypeError in describe).
   datasets.php is loaded in library mode (LUMEN_DATASETS_LIB) from a COPY inside a
   throwaway web root, so admin_root() — dirname(__DIR__) of the library — is that
   root and the list scans the fixtures, never the real DATA_WEB.
     php tests/test_datasets_list_php.php                                       */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-list-' . bin2hex(random_bytes(4));
@mkdir("$root/api", 0777, true);
@mkdir("$root/DATA_WEB/fixed", 0777, true);
@mkdir("$root/DATA_WEB/wholemount", 0777, true);
@mkdir("$root/uploads/state", 0777, true);
foreach (['_admin_lib.php', '_upload_lib.php', 'datasets.php'] as $f) copy(__DIR__ . "/../api/$f", "$root/api/$f");
define('LUMEN_DATASETS_LIB', true);
require_once "$root/api/datasets.php";

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
function put(string $dir, array $meta): void {
    @mkdir($dir, 0777, true);
    file_put_contents("$dir/metadata.json", json_encode($meta));
}

$DATA_WEB = "$root/DATA_WEB";   // what the copied library computed for itself

echo "published datasets\n";
put("$DATA_WEB/fixed/Alpha", ['name' => 'Alpha', 'type' => 'fixed', 'stageNumeric' => 8]);
put("$DATA_WEB/fixed/Numeric", ['name' => 240822, 'type' => 'fixed', 'stageNumeric' => 8]);
put("$DATA_WEB/wholemount/Photo", ['name' => 'Photo', 'type' => 'wholemount', 'stageNumeric' => 7.75,
    'image' => ['native' => 'image.webp', 'preview' => 'preview.webp', 'width' => 4, 'height' => 3]]);
$latin1 = "Embryon_R\xE9";
@mkdir("$DATA_WEB/fixed/$latin1", 0777, true);

$rows = null; $err = null;
try { $rows = list_datasets(); } catch (Throwable $e) { $err = $e->getMessage(); }
check('a numeric "name" does not throw the sort', $err === null);
check('every folder is listed (numeric name, latin-1 folder, wholemount)', is_array($rows) && count($rows) === 4);
check('the wholemount row carries its type', is_array($rows) && in_array('wholemount', array_column($rows, 'type'), true));

echo "\nstaged imports\n";
file_put_contents("$root/uploads/state/fixed__Broken.json", json_encode([
    'type' => 'fixed', 'folder' => 'Broken', 'files' => ['metadata.json' => 'not-an-object', 'x.bin' => null],
]));
file_put_contents("$root/uploads/state/fixed__Scalar.json", json_encode(['type' => 'fixed', 'folder' => 'Scalar', 'files' => 'oops']));
file_put_contents("$root/uploads/state/fixed__Good.json", json_encode([
    'type' => 'fixed', 'folder' => 'Good', 'updatedAt' => date('c'),
    'files' => ['metadata.json' => ['size' => 10, 'tier' => 0, 'kind' => 'metadata', 'done' => true]],
]));
$staged = null; $err = null;
try { $staged = lumen_staged_rows(); } catch (Throwable $e) { $err = $e->getMessage(); }
check('corrupt journals do not throw', $err === null);
check('the well-formed journal is still listed', is_array($staged) && in_array('staging:fixed/Good', array_column($staged, 'id'), true));

echo "\nthe answer as the tab receives it\n";
$payload = ['datasets' => array_merge($rows ?? [], $staged ?? [])];
$expected = count($payload['datasets']);
// Windows transcodes the folder name to valid UTF-8 on the way back from scandir,
// so the invalid byte is injected explicitly: it is the same trap json_out meets
// on a Linux host, where the raw Latin-1 name comes straight from the disk.
$payload['datasets'][0]['name'] = "Embryon_R\xE9";
check('plain json_encode fails on a latin-1 name (the trap json_out must cover)',
      json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) === false);
[$status, $body] = admin_json_body($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
check('json_out never emits an empty body', $status === 0 && strlen((string)$body) > 0);
$decoded = json_decode((string)$body, true);
check('json_out body decodes', is_array($decoded) && isset($decoded['datasets']));
check('json_out keeps every row', is_array($decoded) && count($decoded['datasets']) === $expected);

echo "\n" . ($fails ? "$fails FAILURE(S)\n" : "ALL PASS\n");
exit($fails ? 1 : 0);
