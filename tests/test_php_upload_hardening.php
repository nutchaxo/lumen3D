<?php
/* Import store hardening (api/_upload_lib.php): no markup file type in a dataset's
   download/ folder (served from this origin), byte ranges including the suffix form,
   the journal's `files` map kept a map, and the directory guards' text.
   The library is exercised from a COPY inside a throwaway web root, like
   tests/test_upload_php.php, so nothing touches the checkout.
     php tests/test_php_upload_hardening.php                                        */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-uph-' . bin2hex(random_bytes(4));
@mkdir("$root/api", 0777, true);
@mkdir("$root/DATA_WEB/3d", 0777, true);
copy(__DIR__ . '/../api/_admin_lib.php',  "$root/api/_admin_lib.php");
copy(__DIR__ . '/../api/_upload_lib.php', "$root/api/_upload_lib.php");
require_once "$root/api/_upload_lib.php";

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

echo "allowlist\n";
foreach (['report.xml', 'page.html', 'page.htm', 'vector.svg', 'doc.xhtml'] as $f) {
    check("download/$f is refused", lumen_up_classify('3d', "download/$f") === null);
}
check('download/original.ims is accepted', lumen_up_classify('3d', 'download/original.ims') !== null);
check('download/notes.pdf is accepted', lumen_up_classify('3d', 'download/notes.pdf') !== null);

echo "\nbyte ranges\n";
check('a-b', lumen_up_parse_range('bytes=10-19', 100) === [10, 19]);
check('a- (to the end)', lumen_up_parse_range('bytes=90-', 100) === [90, 99]);
check('-n is the LAST n bytes, not the first n+1', lumen_up_parse_range('bytes=-30', 100) === [70, 99]);
check('-n longer than the file → whole file as a range', lumen_up_parse_range('bytes=-500', 100) === [0, 99]);
check('an end past the file is clamped', lumen_up_parse_range('bytes=50-1000', 100) === [50, 99]);
check('a start past the file is unsatisfiable (416)', lumen_up_parse_range('bytes=200-300', 100) === false);
check('garbage is ignored', lumen_up_parse_range('bytes=abc', 100) === null && lumen_up_parse_range('items=1-2', 100) === null);
check('a multi-range is ignored', lumen_up_parse_range('bytes=0-1,5-6', 100) === null);

echo "\njournal\n";
lumen_up_ensure_dirs();
$j = lumen_up_new_journal('3d', 'demo');
check('saving a journal with no files', lumen_up_save_journal($j));
$raw = (string)file_get_contents(lumen_up_journal_path('3d', 'demo'));
check('… writes `files` as a map, never a list (the Python twin iterates a dict)', strpos($raw, '"files":{}') !== false);
check('… leaves no temp file', !glob(lumen_up_state() . '/.tmp-*'));

echo "\nguards\n";
$dw = (string)file_get_contents("$root/DATA_WEB/.htaccess");
$st = (string)file_get_contents("$root/uploads/.htaccess");
check('DATA_WEB guard written, with its marker', strpos($dw, LUMEN_GUARD_MARKER) !== false);
check('no unguarded directive in either guard (every non-comment top-level line is a container)', (function () use ($dw, $st) {
    foreach ([$dw, $st] as $text) {
        $depth = 0;
        foreach (explode("\n", $text) as $line) {
            $t = trim($line);
            if ($t === '' || $t[0] === '#') continue;
            if (preg_match('#^</#', $t)) { $depth--; continue; }
            if (preg_match('#^<#', $t)) { if ($depth === 0 && !preg_match('#^<(IfModule|FilesMatch)\b#', $t)) return false; $depth++; continue; }
            if ($depth === 0) return false;
        }
    }
    return true;
})());
check('download/ files are attachments', strpos($dw, 'Header set Content-Disposition "attachment" env=LUMEN_DOWNLOAD') !== false);
file_put_contents("$root/DATA_WEB/.htaccess", "# operator copy with " . LUMEN_GUARD_MARKER . "\n");
lumen_up_ensure_dirs();
check('a guard carrying the marker is left alone', strpos((string)file_get_contents("$root/DATA_WEB/.htaccess"), 'operator copy') !== false);

echo $fails ? "\n$fails FAILED\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
