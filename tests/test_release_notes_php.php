<?php
/* PHP twin of tests/test_release_notes.py — the release notes an update brings,
   version by version: admin_select_changelogs() keeps the versions between the
   one installed (exclusive) and the latest (inclusive), oldest first;
   admin_parse_release_notes_bundle() reads the lumen3d-release-notes.json asset;
   admin_local_changelogs() lists what is installed, newest first.

   The library is copied into a throwaway web root so changelog_dir() — derived
   from the library's own location — points at the fixtures.
     php tests/test_release_notes_php.php                                       */
declare(strict_types=1);

$root = sys_get_temp_dir() . '/lumen-notes-' . bin2hex(random_bytes(4));
@mkdir("$root/api", 0777, true);
@mkdir("$root/changelog", 0777, true);
foreach (['_admin_lib.php', '_upload_lib.php'] as $f) copy(__DIR__ . "/../api/$f", "$root/api/$f");
require_once "$root/api/_admin_lib.php";

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
$versionsOf = fn(array $rows) => array_map(fn($r) => $r['version'], $rows);

echo "admin_select_changelogs\n";
$versions = ['1.55.0' => 'd', '1.54.0' => 'a', '1.54.2' => 'c', '1.54.1' => 'b', '1.53.9' => 'z', '1.55.1' => 'future'];
$got = admin_select_changelogs($versions, '1.54.0', '1.55.0');
check('between current and latest, oldest first', $versionsOf($got) === ['1.54.1', '1.54.2', '1.55.0']);
check('the markdown rides along', ($got[0]['markdown'] ?? null) === 'b');
check('junk entries are ignored', $versionsOf(admin_select_changelogs(['1.54.1' => '', 'bad' => 'x', '1.54.2' => 3, '1.54.3' => 'ok'], '1.54.0', '1.54.3')) === ['1.54.3']);
check('nothing when up to date', admin_select_changelogs(['1.54.0' => 'a'], '1.54.0', '1.54.0') === []);
check('numeric order, not lexical', $versionsOf(admin_select_changelogs(['1.10.0' => 'x', '1.9.0' => 'y'], '1.8.0', '1.10.0')) === ['1.9.0', '1.10.0']);

echo "\nadmin_parse_release_notes_bundle\n";
$raw = json_encode(['versions' => [['version' => '1.2.3', 'markdown' => 'm'], ['version' => 1, 'markdown' => 'x'], 'junk', ['version' => '1.2.4']]]);
check('keeps only well-formed entries', admin_parse_release_notes_bundle($raw) === ['1.2.3' => 'm']);
check('garbage is an empty bundle', admin_parse_release_notes_bundle('[]') === [] && admin_parse_release_notes_bundle('not json') === []);

echo "\nadmin_release_notes_bundle without the asset\n";
check('a release that predates the asset gives null', admin_release_notes_bundle(['tag_name' => 'v1.54.0', 'assets' => [['name' => 'SHA256SUMS']]]) === null);
check('an oversized asset is refused before download', admin_release_notes_bundle(['tag_name' => 'v1.54.0', 'assets' => [['name' => RELEASE_NOTES_ASSET, 'browser_download_url' => 'https://x/n.json', 'size' => RELEASE_NOTES_MAX_BYTES + 1]]]) === null);

echo "\nadmin_local_changelogs\n";
file_put_contents("$root/changelog/changelog_1.2.3.md", "# a\n");
file_put_contents("$root/changelog/changelog_1.10.0.md", "# b\n");
file_put_contents("$root/changelog/changelog_1.9.9.md", "   ");
file_put_contents("$root/changelog/notes.md", "# junk\n");
$local = admin_local_changelogs();
check('newest first, numeric order, only real changelogs', $versionsOf($local) === ['1.10.0', '1.2.3']);
check('the markdown is the file', ($local[0]['markdown'] ?? null) === "# b\n");

echo $fails ? "\n$fails FAILURE(S)\n" : "\nALL PASS\n";
exit($fails ? 1 : 0);
