<?php
/* Page version history, PHP side: api/page-versions.php + api/_page_versions_lib.php
   (the Python twin is tests/test_page_versions.py; the file both write is the one pinned by the
   golden below, DOCS/pages-library/SPEC.md §2).

   Library mode (LUMEN_PV_LIB) drives every action through pv_handle() with bodies decoded the way
   the entry point decodes them (lumen_json_decode_doc, so `{}` stays an object); a second part
   starts the real entry point under `php -S` with a session + CSRF token to cover the HTTP rules
   (401 / 403 / 405, no-store, answers on the wire).
     php tests/test_page_versions_php.php                                           */
declare(strict_types=1);

if (PHP_VERSION_ID < 70400) { echo "SKIP: PHP >= 7.4 required\n"; exit(0); }
@ini_set('memory_limit', '1024M');

$root = sys_get_temp_dir() . '/lumen-pv-' . bin2hex(random_bytes(4));
@mkdir($root, 0777, true);
define('LUMEN_PRIVATE_DIR', $root);
define('LUMEN_CRED_FILE', $root . '/admin_credential.json');
define('LUMEN_CONFIG_DIR', $root . '/config');
define('LUMEN_PAGE_DRAFTS_DIR', $root . '/drafts');
define('LUMEN_PAGE_VERSIONS_DIR', $root . '/versions');
define('LUMEN_SITE_LIB', true);
define('LUMEN_PV_LIB', true);
@mkdir(LUMEN_CONFIG_DIR . '/pages', 0777, true);
require_once __DIR__ . '/../api/page-versions.php';

function rrm(string $d): void {
    if (!is_dir($d)) { @unlink($d); return; }
    foreach (scandir($d) ?: [] as $f) { if ($f !== '.' && $f !== '..') rrm("$d/$f"); }
    @rmdir($d);
}
$server = null;
register_shutdown_function(function () use ($root, &$server) {
    if (is_resource($server)) { @proc_terminate($server); @proc_close($server); }
    rrm($root);
});

$fails = 0;
function check(string $name, $cond): void {
    global $fails;
    echo ($cond ? "  ok   " : "  FAIL ") . "$name\n";
    if (!$cond) { $fails++; }
}

// Nothing below may raise a warning, notice or deprecation, whatever the body.
$noise = [];
set_error_handler(function ($no, $str, $file, $line) use (&$noise) {
    if (!(error_reporting() & $no)) return true;     // @-silenced
    $noise[] = "$str @ " . basename($file) . ":$line";
    return true;
});

/** A request body as the entry point hands it to pv_handle: JSON text decoded by lumen_json_decode_doc. */
function body($b) {
    if ($b === null) return null;
    return lumen_json_decode_doc(is_string($b) ? $b : (string)json_encode($b));
}
function call(string $action, $slug, $id = null, $b = null): array { return pv_handle($action, $slug, $id, body($b)); }
function block(string $id, string $text = 'Hello'): array {
    return ['sections' => [['id' => $id, 'columns' => [['width' => 12, 'widgets' => [['type' => 'heading', 'text' => ['en' => $text, 'fr' => $text . ' fr']]]]]]]];
}
function add(string $slug, array $content, array $extra = []): array {
    return call('add', $slug, null, $extra + ['origin' => 'capture', 'content' => $content]);
}
function live(string $slug): array { $d = site_load_admin('pages/' . $slug); return is_array($d) ? $d : []; }
function ulen(string $s): int { return (int)preg_match_all('/./su', $s); }
function cj($v): string { return pv_canon_json($v); }
function file_of(string $slug): array {
    $raw = (string)@file_get_contents(LUMEN_PAGE_VERSIONS_DIR . "/$slug.json");
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

// ── 1. Slugs and ids: nothing reaches the file system unless it is a plain slug ──
echo "slug and id\n";
$badSlugs = ['../evil', '..', '.', 'a/b', 'a\\b', "a\0b", 'A', 'About', '-x', '_x', 'x.json', 'a b', '', str_repeat('a', 65), '%2e%2e', "x\n"];
foreach ($badSlugs as $s) {
    foreach (['get', 'add', 'update', 'activate', 'delete', 'purge'] as $a) {
        [$st, $o] = pv_handle($a, $s, 'v0123456789ab', body(['origin' => 'capture', 'content' => ['published' => block('s')]]));
        if ($st !== 400 || ($o['error'] ?? '') !== 'invalid_slug') { check("slug " . json_encode($s) . " refused by $a", false); }
    }
    [$st, $o] = pv_handle('list', $s, null, null);
    // A blank slug is no filter at all (the Python server's query parser drops it): every history is listed.
    if ($s === '') { if ($st !== 200 || !isset($o['pages'])) check('list with a blank slug lists everything', false); }
    elseif ($st !== 400 || ($o['error'] ?? '') !== 'invalid_slug') check("list slug " . json_encode($s), false);
}
check('every unsafe slug is refused with invalid_slug by every action', true);
check('no file escaped the storage directory', !file_exists("$root/evil.json") && !file_exists(dirname($root) . '/evil.json') && !is_dir(LUMEN_PAGE_VERSIONS_DIR));
check('pv_path is null for an unsafe slug and in the storage dir for a safe one', pv_path('../x') === null && pv_path('about') === LUMEN_PAGE_VERSIONS_DIR . '/about.json');
foreach (['v123', 'V0123456789ab', 'v0123456789abc', 'v0123456789AB', '../../x', 'v0123456789a/', "v0123456789ab\n", '', 'vzzzzzzzzzzzz'] as $i) {
    [$st, $o] = pv_handle('get', 'about', $i, null);
    if ($st !== 400 || ($o['error'] ?? '') !== 'invalid_id') check('id ' . json_encode($i), false);
}
[$st, $o] = pv_handle('get', 'about', null, null);
check('a missing id is invalid_id', $st === 400 && $o['error'] === 'invalid_id');
[$st, $o] = pv_handle('nope', 'about', null, null);
check('an unknown action is 400 Unknown action', $st === 400 && $o['error'] === 'Unknown action');
[$st, $o] = pv_handle('get', 'about', 'v0123456789ab', null);
check('a well-formed id that does not exist is 404 not_found', $st === 404 && $o['error'] === 'not_found');
[$st, $o] = call('list', null);
check('list with no history at all', $st === 200 && $o['schema'] === 'lumen-page-versions/1'
    && $o['limits'] === ['maxVersions' => 50, 'maxBytes' => 33554432] && json_encode($o['pages']) === '{}');
[$st, $o] = call('list', 'about');
check('list of one page without history = pages {}', $st === 200 && json_encode($o['pages']) === '{}');

// ── 2. add / get / list ────────────────────────────────────────────────────────
echo "add, get, list\n";
$A = block('a1', 'Alpha'); $B = block('b1', 'Beta'); $C = block('c1', 'Gamma');
[$st, $o] = add('about', ['title' => ['en' => 'About', 'fr' => 'A propos'], 'nav' => ['label' => ['en' => 'About'], 'show' => true], 'published' => $A, 'draft' => $B],
    ['label' => "  Spring\tredesign\n ", 'note' => "line1\nline2\x01", 'origin' => 'import', 'exportedAt' => '2026-11-18T09:00:00.000Z', 'source' => 'bemine.be', 'platform' => '1.86.0']);
check('add answers ok + id + META', $st === 200 && $o['ok'] === true && preg_match(PV_ID_RX, $o['id']) === 1 && $o['version']['id'] === $o['id']);
$v1 = $o['id'];
$m = $o['version'];
check('label is trimmed and one-line, note keeps its line break and loses control chars', $m['label'] === 'Spring redesign' && $m['note'] === "line1\nline2");
check('origin / info strings kept', $m['origin'] === 'import' && $m['exportedAt'] === '2026-11-18T09:00:00.000Z' && $m['source'] === 'bemine.be' && $m['platform'] === '1.86.0');
check('timestamps are UTC seconds', preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/', $m['createdAt']) === 1 && $m['createdAt'] === $m['updatedAt']);
check('META: widgets, bytes, locales, flags, title', $m['widgets'] === 1 && $m['bytes'] > 100 && $m['locales'] === ['en', 'fr'] && $m['hasPublished'] && $m['hasDraft']
    && $m['title'] === ['en' => 'About', 'fr' => 'A propos'] && $m['isActive'] === false);
check('META carries no content', !array_key_exists('content', $m));
check('file is 0600 on a POSIX host', DIRECTORY_SEPARATOR === '\\' || (fileperms(LUMEN_PAGE_VERSIONS_DIR . '/about.json') & 0777) === 0600);
[$st, $o] = pv_handle('get', 'about', $v1, null);
check('get returns META + content', $st === 200 && $o['ok'] === true && $o['version']['id'] === $v1 && $o['version']['content']['published'] === $A
    && $o['version']['content']['draft'] === $B && array_keys($o['version']['content']) === ['title', 'nav', 'published', 'draft']);
[$st, $o2] = add('about', ['published' => $C], ['origin' => 'manual']);
$v2 = $o2['id'];
check('default label is Version', $o2['version']['label'] === 'Version' && $o2['version']['note'] === '' && $o2['version']['exportedAt'] === '');
[$st, $o3] = add('about', ['draft' => $C], ['origin' => 'auto', 'label' => str_repeat('é', 300), 'note' => str_repeat('n', 5000), 'source' => str_repeat('s', 200)]);
check('label cut to 120 characters (multibyte safe), note to 2000, info strings to 64', ulen($o3['version']['label']) === 120 && strlen($o3['version']['note']) === 2000 && strlen($o3['version']['source']) === 64);
$v3 = $o3['id'];
[$st, $o] = call('list', 'about');
$ids = array_column($o['pages']->about['versions'], 'id');
check('list is newest first, count and active', $st === 200 && $ids === [$v3, $v2, $v1] && $o['pages']->about['count'] === 3 && $o['pages']->about['active'] === null);
[$st, $o] = call('list', null);
check('list without slug answers every page that has a history', isset($o['pages']->about) && count(get_object_vars($o['pages'])) === 1);
check('a one-block version has no draft flag', $o['pages']->about['versions'][1]['hasDraft'] === false && $o['pages']->about['versions'][1]['hasPublished'] === true);

// ── 3. Format golden ───────────────────────────────────────────────────────────
echo "file format\n";
$f = file_of('about');
check('top-level key order', array_keys($f) === ['schema', 'slug', 'active', 'versions']);
check('version key order', array_keys($f['versions'][0]) === ['id', 'label', 'note', 'origin', 'createdAt', 'updatedAt', 'exportedAt', 'source', 'platform', 'content']);
check('versions are stored oldest first', array_column($f['versions'], 'id') === [$v1, $v2, $v3]);
rrm(LUMEN_PAGE_VERSIONS_DIR);
[$st, $g] = call('add', 'golden', null, '{"origin":"import","label":"Spring redesign","exportedAt":"2026-11-18T09:00:00.000Z","source":"bemine.be","platform":"1.86.0",'
    . '"content":{"title":{},"nav":{"label":{"en":"Golden"},"show":true},"published":{"sections":[{"id":"s1","columns":[{"width":12,"widgets":[{"type":"spacer","props":{}}]}]}],"background":{"preset":"x","params":{}}}}}');
check('golden version stored', $st === 200);
$goldenRaw = (string)file_get_contents(LUMEN_PAGE_VERSIONS_DIR . '/golden.json');
$gd = json_decode($goldenRaw);
$gv = $gd->versions[0];
$golden = '{"schema":"lumen-page-versions/1","slug":"golden","active":null,"versions":[{"id":"@ID@","label":"Spring redesign","note":"","origin":"import",'
    . '"createdAt":"@T@","updatedAt":"@T@","exportedAt":"2026-11-18T09:00:00.000Z","source":"bemine.be","platform":"1.86.0",'
    . '"content":{"title":{},"nav":{"label":{"en":"Golden"},"show":true},"published":{"sections":[{"id":"s1","columns":[{"width":12,"widgets":[{"type":"spacer","props":{}}]}]}],"background":{"preset":"x","params":{}}}}}]}';
$gv->id = '@ID@'; $gv->createdAt = '@T@'; $gv->updatedAt = '@T@';
check('stored file equals the golden (key order, empty objects stay {})', json_encode($gd, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) === $golden);
check('empty objects are written {} in the file, never []', strpos($goldenRaw, '"title": {}') !== false && strpos($goldenRaw, '"props": {}') !== false && strpos($goldenRaw, '[]') === false);
check('a file written by the Python twin (2-space indent) reads the same', (function () use ($golden) {
    $py = LUMEN_PAGE_VERSIONS_DIR . '/pyfile.json';
    $d = json_decode(str_replace(['@ID@', '@T@', '"slug":"golden"'], ['v0a1b2c3d4e50', '2026-11-19T13:45:07Z', '"slug":"pyfile"'], $golden));
    $d->active = 'v0a1b2c3d4e50';
    file_put_contents($py, json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    $h = pv_load('pyfile');
    return $h['state'] === 'ok' && $h['active'] === 'v0a1b2c3d4e50' && count($h['versions']) === 1 && $h['versions'][0]['label'] === 'Spring redesign';
})());
@unlink(LUMEN_PAGE_VERSIONS_DIR . '/pyfile.json');

// The files the Python twin pins (tests/fixtures/page-versions): the history is read, listed and rewritten identically.
$fx = __DIR__ . '/fixtures/page-versions';
if (is_file("$fx/about.history.json") && is_file("$fx/about.list.json")) {
    rrm(LUMEN_PAGE_VERSIONS_DIR);
    @mkdir(LUMEN_PAGE_VERSIONS_DIR, 0777, true);
    copy("$fx/about.history.json", LUMEN_PAGE_VERSIONS_DIR . '/about.json');
    [$st, $o] = pv_action_list('about');
    $want = json_decode((string)file_get_contents("$fx/about.list.json"));
    check('list of the Python golden history = the golden list (META: widgets, bytes, locales, flags)', $st === 200 && pv_canon_json($o) === pv_canon_json($want));
    $h = pv_load('about');
    check('the golden history loads whole', $h['state'] === 'ok' && $h['active'] === 'v000000000002' && count($h['versions']) === 3);
    check('rewriting it changes nothing but whitespace', pv_persist('about', $h) === null
        && pv_canon_json(json_decode((string)file_get_contents(LUMEN_PAGE_VERSIONS_DIR . '/about.json'))) === pv_canon_json(json_decode((string)file_get_contents("$fx/about.history.json"))));
    $rw = json_decode((string)file_get_contents(LUMEN_PAGE_VERSIONS_DIR . '/about.json'));
    check('...key order included', array_keys(get_object_vars($rw)) === ['schema', 'slug', 'active', 'versions']
        && array_keys(get_object_vars($rw->versions[0])) === ['id', 'label', 'note', 'origin', 'createdAt', 'updatedAt', 'exportedAt', 'source', 'platform', 'content']
        && array_keys(get_object_vars($rw->versions[0]->content)) === ['title', 'nav', 'published', 'draft']);
    rrm(LUMEN_PAGE_VERSIONS_DIR);
} else {
    echo "  SKIP the golden fixtures of the Python twin are absent\n";
}

// ── 4. Malformed input ─────────────────────────────────────────────────────────
echo "malformed input\n";
$ok = $A;
$cases = [
    'a list body'                        => ['[1,2,3]', 'invalid_body'],
    'a string body'                      => ['"hello"', 'invalid_body'],
    'a number body'                      => ['123', 'invalid_body'],
    'no body'                            => [null, 'invalid_body'],
    'an empty object'                    => ['{}', 'invalid_origin'],
    'origin of the wrong type'           => ['{"origin":["import"],"content":{}}', 'invalid_origin'],
    'unknown origin'                     => ['{"origin":"hacker","content":{}}', 'invalid_origin'],
    'no content'                         => ['{"origin":"import"}', 'invalid_content'],
    'content is a list'                  => ['{"origin":"import","content":[1]}', 'invalid_content'],
    'content is a string'                => ['{"origin":"import","content":"x"}', 'invalid_content'],
    'content is empty'                   => ['{"origin":"import","content":{}}', 'invalid_content'],
    'content without a block'            => ['{"origin":"import","content":{"title":{"en":"x"}}}', 'invalid_content'],
    'published is a list'                => ['{"origin":"import","content":{"published":[]}}', 'invalid_content'],
    'published is {}'                    => ['{"origin":"import","content":{"published":{}}}', 'invalid_content'],
    'sections is an object'              => ['{"origin":"import","content":{"published":{"sections":{}}}}', 'invalid_content'],
    'a section is a string'              => ['{"origin":"import","content":{"published":{"sections":["x"]}}}', 'invalid_content'],
    'columns is a string'                => ['{"origin":"import","content":{"published":{"sections":[{"columns":"x"}]}}}', 'invalid_content'],
    'a widget without a type'            => ['{"origin":"import","content":{"published":{"sections":[{"columns":[{"widgets":[{"x":1}]}]}]}}}', 'invalid_content'],
    'a widget that is a number'          => ['{"origin":"import","content":{"published":{"sections":[{"columns":[{"widgets":[7]}]}]}}}', 'invalid_content'],
    'legacy blocks that are not widgets' => ['{"origin":"import","content":{"published":{"blocks":[1]}}}', 'invalid_content'],
    'title is a number'                  => ['{"origin":"import","content":{"title":5,"published":{"sections":[]}}}', 'invalid_content'],
    'title value is not a string'        => ['{"origin":"import","content":{"title":{"en":5},"published":{"sections":[]}}}', 'invalid_content'],
    'title key is not a locale'          => ['{"origin":"import","content":{"title":{"a b c":"x"},"published":{"sections":[]}}}', 'invalid_content'],
    'nav.show is a string'               => ['{"origin":"import","content":{"nav":{"show":"yes"},"published":{"sections":[]}}}', 'invalid_content'],
    'nav is a list'                      => ['{"origin":"import","content":{"nav":[1],"published":{"sections":[]}}}', 'invalid_content'],
    'label is a number'                  => ['{"origin":"import","label":5,"content":{"published":{"sections":[]}}}', 'invalid_body'],
    'note is an array'                   => ['{"origin":"import","note":["x"],"content":{"published":{"sections":[]}}}', 'invalid_body'],
    'source is an object'                => ['{"origin":"import","source":{},"content":{"published":{"sections":[]}}}', 'invalid_body'],
    'activate is a number'               => ['{"origin":"import","activate":1,"content":{"published":{"sections":[]}}}', 'invalid_mode'],
    'activate is unknown'                => ['{"origin":"import","activate":"now","content":{"published":{"sections":[]}}}', 'invalid_mode'],
    'too many sections'                  => [json_encode(['origin' => 'import', 'content' => ['published' => ['sections' => array_fill(0, 301, ['id' => 's'])]]]), 'invalid_content'],
    'too many columns'                   => [json_encode(['origin' => 'import', 'content' => ['published' => ['sections' => [['columns' => array_fill(0, 13, ['width' => 1])]]]]]), 'invalid_content'],
    'a block over the 2 MiB page limit'  => [json_encode(['origin' => 'import', 'content' => ['published' => ['sections' => [['id' => str_repeat('x', 2200000)]]]]]), 'version_too_large'],
];
foreach ($cases as $name => [$raw, $want]) {
    $b = $raw === null ? null : lumen_json_decode_doc($raw);
    [$st, $o] = pv_handle('add', 'junk', null, $b);
    check("add: $name → $want", $st === ($want === 'version_too_large' ? 413 : 400) && ($o['error'] ?? '') === $want);
}
check('none of them left a file behind', !is_file(LUMEN_PAGE_VERSIONS_DIR . '/junk.json'));
// garbage that never decodes
foreach (['{"origin":', "\xff\xfe", '{"a":1}}', str_repeat('[', 600) . str_repeat(']', 600)] as $garbage) {
    $d = lumen_json_decode_doc($garbage);
    [$st, $o] = pv_handle('add', 'junk', null, $d);
    if (!($st === 400 && $o['error'] === 'invalid_body')) check('garbage ' . substr(bin2hex($garbage), 0, 12), false);
}
check('undecodable bodies are invalid_body', true);
// null bytes and huge strings
[$st, $o] = call('add', 'junk', null, ['origin' => 'import', 'label' => "a\0b\u{0007}c", 'note' => "n\0", 'source' => "x\0y", 'content' => ['published' => $ok]]);
check('null bytes and control characters in text are stripped', $st === 200 && $o['version']['label'] === 'abc' && $o['version']['note'] === 'n' && $o['version']['source'] === 'xy');
[$st, $o] = call('add', 'junk', null, ['origin' => 'import', 'label' => str_repeat('L', 3000000), 'content' => ['published' => $ok]]);
check('a 3 MB label is cut, not stored whole', $st === 200 && strlen($o['version']['label']) === 120);
[$st, $o] = call('add', 'junk', null, ['origin' => 'import', 'content' => ['title' => ['en' => str_repeat('t', 5000)], 'published' => $ok]]);
check('an oversized title is refused', $st === 400 && $o['error'] === 'invalid_content');
// deep nesting inside a widget: a graceful answer either way, and a readable file when accepted
$deep = 'null'; for ($i = 0; $i < 470; $i++) $deep = '{"a":' . $deep . '}';
[$st, $o] = call('add', 'deep', null, '{"origin":"import","content":{"published":{"sections":[{"columns":[{"widgets":[{"type":"x","props":' . $deep . '}]}]}]}}}');
check('a very deeply nested widget is answered, never a PHP error', in_array($st, [200, 400, 500], true) && ($st !== 200 || pv_load('deep')['state'] === 'ok'));
[$st, $o] = call('add', 'junk', null, '{"origin":"import","content":{"published":{"sections":[{"columns":[{"widgets":[{"type":"x","props":{"0":"a","1":"b"}}]}]}]}}}');
$gj = (string)file_get_contents(LUMEN_PAGE_VERSIONS_DIR . '/junk.json');
check('an object whose keys read 0..n-1 stays an object', $st === 200 && strpos($gj, '"0": "a"') !== false);
// update / activate / delete on garbage
$v = call('add', 'junk2', null, ['origin' => 'capture', 'content' => ['published' => $ok]])[1]['id'];
foreach (['[1]', '"x"', null, '7'] as $raw) {
    [$st, $o] = pv_handle('update', 'junk2', $v, $raw === null ? null : lumen_json_decode_doc($raw));
    if (!($st === 400 && $o['error'] === 'invalid_body')) check('update garbage ' . var_export($raw, true), false);
}
check('update with a non-object body is invalid_body', true);
foreach ([['{}', 'nothing_to_update'], ['{"label":3}', 'invalid_body'], ['{"fromLive":"yes"}', 'invalid_body'], ['{"content":[]}', 'invalid_content'],
          ['{"content":{"published":{"sections":[]}},"fromLive":true}', 'invalid_body'], ['{"fromLive":false}', 'nothing_to_update']] as [$raw, $want]) {
    [$st, $o] = pv_handle('update', 'junk2', $v, lumen_json_decode_doc($raw));
    check("update $raw → $want", $st === 400 && $o['error'] === $want);
}
foreach (['[1]', '"x"', '{"mode":"publishnow"}', '{"mode":5}', '{"snapshotLabel":[1]}'] as $raw) {
    [$st, $o] = pv_handle('activate', 'junk2', $v, lumen_json_decode_doc($raw));
    if (!($st === 400 && in_array($o['error'], ['invalid_body', 'invalid_mode'], true))) check("activate garbage $raw", false);
}
check('activate with a bad body / mode is refused', true);
check('...and left the page untouched', live('junk2') === []);

// ── 5. update ──────────────────────────────────────────────────────────────────
echo "update\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
$v1 = add('up', ['title' => ['en' => 'T'], 'nav' => ['label' => ['en' => 'N'], 'show' => false], 'published' => $A])[1]['id'];
usleep(1100000);
[$st, $o] = call('update', 'up', $v1, ['label' => 'Renamed', 'note' => 'a note']);
check('rename + note change label, note and updatedAt only', $st === 200 && $o['version']['label'] === 'Renamed' && $o['version']['note'] === 'a note'
    && $o['version']['updatedAt'] > $o['version']['createdAt'] && $o['version']['widgets'] === 1);
check('and not the content', pv_load('up')['versions'][0]['content']['published'] === $A);
[$st, $o] = call('update', 'up', $v1, ['label' => '   ']);
check('an empty label falls back to Version', $st === 200 && $o['version']['label'] === 'Version');
[$st, $o] = call('update', 'up', $v1, ['content' => ['draft' => $B]]);
check('content replaces the content wholesale', $st === 200 && $o['version']['hasDraft'] && !$o['version']['hasPublished']
    && array_keys(pv_load('up')['versions'][0]['content']) === ['draft']);
[$st, $o] = call('update', 'up', 'v0123456789ab', ['label' => 'x']);
check('update of an unknown id is 404', $st === 404 && $o['error'] === 'not_found');
[$st, $o] = call('update', 'up', $v1, ['fromLive' => true]);
check('fromLive on a page with no live content is refused', $st === 400 && $o['error'] === 'invalid_content');
site_save_checked('pages/up', ['title' => ['en' => 'Live'], 'published' => $C], null, null);
site_save_draft('pages/up', ['draft' => $B], null);
call('update', 'up', $v1, ['content' => ['nav' => ['label' => ['en' => 'N'], 'show' => false], 'draft' => $B]]);
[$st, $o] = call('update', 'up', $v1, ['fromLive' => true]);
$stored = pv_load('up')['versions'][0]['content'];
check('fromLive = the live published + draft + title, nav kept as it was', $st === 200 && $stored['published'] === $C && $stored['draft'] === $B
    && $stored['title'] === ['en' => 'Live'] && cj($stored['nav']) === cj(['label' => ['en' => 'N'], 'show' => false])
    && array_keys($stored) === ['title', 'nav', 'published', 'draft']);

// ── 6. activate: publish ───────────────────────────────────────────────────────
echo "activate (publish)\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
$T1 = ['en' => 'Version one'];
$idA = add('act', ['title' => $T1, 'published' => $A, 'draft' => $B])[1]['id'];
$idB = add('act', ['published' => $C])[1]['id'];
$idC = add('act', ['draft' => $B])[1]['id'];
[$st, $o] = call('activate', 'act', $idA, ['mode' => 'publish']);
check('activate answers ok, rev, active and no snapshot on an empty page', $st === 200 && $o['ok'] === true && $o['active'] === $idA && !array_key_exists('snapshotId', $o)
    && $o['rev'] === site_rev('pages/act'));
$l = live('act');
check('publish: published / draft / title from the version, schemaVersion 2', $l['published'] === $A && $l['draft'] === $B && $l['title'] === $T1 && $l['schemaVersion'] === 2);
check('the public file carries no draft, the draft file holds it', strpos((string)file_get_contents(LUMEN_CONFIG_DIR . '/pages/act.json'), 'Beta') === false
    && strpos((string)file_get_contents(LUMEN_PAGE_DRAFTS_DIR . '/act.json'), 'Beta') !== false);
check('the active marker is persisted and list says so', pv_load('act')['active'] === $idA && call('list', 'act')[1]['pages']->act['versions'][2]['isActive'] === true);
// a version with only a published block: the editor still gets a draft = published; no title in the version keeps the live one
[$st, $o] = call('activate', 'act', $idB, null);
$l = live('act');
check('a published-only version fills the draft too and leaves the title alone', $st === 200 && $l['published'] === $C && $l['draft'] === $C && $l['title'] === $T1);
check('default mode is publish (active moved)', pv_load('act')['active'] === $idB);
check('the live state was a known version: no snapshot was taken', count(pv_load('act')['versions']) === 3);
// a draft-only version
[$st, $o] = call('activate', 'act', $idC, ['mode' => 'publish']);
$l = live('act');
check('a draft-only version publishes its draft', $l['published'] === $B && $l['draft'] === $B);
// end state = what the editor's publish path (pageWrites) gives
foreach ([
    'both blocks + title' => ['title' => ['en' => 'X', 'fr' => 'Y'], 'published' => $A, 'draft' => $B],
    'published only'      => ['published' => $A],
    'draft only'          => ['draft' => $B],
] as $name => $content) {
    $slugA = 'ea' . substr(md5($name), 0, 6); $slugB = 'eb' . substr(md5($name), 0, 6);
    $id = add($slugA, $content)[1]['id'];
    call('activate', $slugA, $id, ['mode' => 'publish']);
    $pub = $content['published'] ?? $content['draft'];
    $title = $content['title'] ?? null;
    site_save_draft('pages/' . $slugB, ['draft' => $pub] + ($title ? ['title' => $title] : []), null);
    site_publish_doc('pages/' . $slugB);
    if (isset($content['published']) && isset($content['draft'])) site_save_draft('pages/' . $slugB, ['draft' => $content['draft']], null);
    // schemaVersion 2 is stamped by the editor's title save only; the contract stamps it on every activation
    $noSchema = function (array $d): array { unset($d['schemaVersion']); return $d; };
    $x = cj($noSchema(live($slugA))); $y = cj($noSchema(live($slugB)));
    $pubA = $noSchema((array)json_decode((string)file_get_contents(LUMEN_CONFIG_DIR . "/pages/$slugA.json"), true));
    $pubB = $noSchema((array)json_decode((string)file_get_contents(LUMEN_CONFIG_DIR . "/pages/$slugB.json"), true));
    $drA = json_decode((string)file_get_contents(LUMEN_PAGE_DRAFTS_DIR . "/$slugA.json"), true);
    $drB = json_decode((string)file_get_contents(LUMEN_PAGE_DRAFTS_DIR . "/$slugB.json"), true);
    check("publish end state equals the editor's save_draft + publish path ($name)", $x === $y && cj($pubA) === cj($pubB) && cj($drA) === cj($drB));
}

// ── 7. activate: draft ─────────────────────────────────────────────────────────
echo "activate (draft)\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
$idP = add('dr', ['title' => ['en' => 'Pub'], 'published' => $A])[1]['id'];
$idD = add('dr', ['title' => ['en' => 'Dra'], 'published' => $C, 'draft' => $B])[1]['id'];
call('activate', 'dr', $idP, ['mode' => 'publish']);
[$st, $o] = call('activate', 'dr', $idD, ['mode' => 'draft']);
$l = live('dr');
check('draft mode: the draft and the title change, the published block does not', $st === 200 && $l['published'] === $A && $l['draft'] === $B && $l['title'] === ['en' => 'Dra']);
check('draft mode leaves the active marker alone', $o['active'] === $idP && pv_load('dr')['active'] === $idP);
$idE = add('dr', ['published' => $C])[1]['id'];
[$st, $o] = call('activate', 'dr', $idE, ['mode' => 'draft']);
check('a published-only version becomes the draft', live('dr')['draft'] === $C && live('dr')['published'] === $A);
[$st, $o] = call('activate', 'ghostpage', $idE, ['mode' => 'draft']);
check('activating on a page without history is 404', $st === 404 && $o['error'] === 'not_found');
$idN = add('newpage', ['draft' => $B])[1]['id'];
[$st] = call('activate', 'newpage', $idN, ['mode' => 'draft']);
check('draft mode on a page that has no published block creates {"sections":[]}', $st === 200 && live('newpage')['published'] === ['sections' => []] && live('newpage')['draft'] === $B);
check('mode draft in add + activate', call('add', 'newpage2', null, ['origin' => 'import', 'content' => ['published' => $A, 'draft' => $B], 'activate' => 'draft'])[0] === 200
    && live('newpage2')['draft'] === $B && pv_load('newpage2')['active'] === null);

// ── 8. Safety snapshot ─────────────────────────────────────────────────────────
echo "safety snapshot\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
[$st, $o] = call('add', 'snap', null, ['origin' => 'import', 'content' => ['published' => $A], 'activate' => 'publish']);
check('add + activate on an empty page: no snapshot, version active', $st === 200 && !isset($o['snapshotId']) && $o['version']['isActive'] === true && live('snap')['published'] === $A);
$s1 = $o['id'];
site_save_draft('pages/snap', ['draft' => $B], null);             // the operator edits: live = (A, B)
[$st, $o] = call('add', 'snap', null, ['origin' => 'import', 'content' => ['published' => $C], 'activate' => 'publish']);
$s2 = $o['id'];
check('activating over an unsaved live state takes a snapshot first', $st === 200 && is_string($o['snapshotId'] ?? null));
$h = pv_load('snap');
$snapV = $h['versions'][pv_find($h, $o['snapshotId'])];
check('the snapshot is origin auto, labelled "Before activation", holds the live published + draft', $snapV['origin'] === 'auto' && $snapV['label'] === 'Before activation'
    && $snapV['content']['published'] === $A && $snapV['content']['draft'] === $B && count($h['versions']) === 3);
check('the activated version is the active one, live = it', $h['active'] === $s2 && live('snap')['published'] === $C);
[$st, $o] = call('activate', 'snap', $s1, null);
check('re-activating a stored version over a state some version captures takes NO snapshot', $st === 200 && !isset($o['snapshotId']) && count(pv_load('snap')['versions']) === 3);
$revBefore = site_rev('pages/snap');
[$st, $o] = call('activate', 'snap', $s1, null);
check('activating the active, unchanged version succeeds and writes nothing', $st === 200 && site_rev('pages/snap') === $revBefore && !isset($o['snapshotId']) && count(pv_load('snap')['versions']) === 3);
site_save_draft('pages/snap', ['draft' => block('z', 'Zed')], null);
[$st, $o] = call('activate', 'snap', $s2, ['snapshotLabel' => "  My\tbackup "]);
$h = pv_load('snap');
check('snapshotLabel names the snapshot', $st === 200 && $h['versions'][pv_find($h, $o['snapshotId'])]['label'] === 'My backup');
call('activate', 'snap', $s1, null);
site_save_draft('pages/snap', ['draft' => block('z', 'Zed')], null);
$n = count(pv_load('snap')['versions']);
[$st, $o] = call('activate', 'snap', $s2, null);
check('the same unsaved state snapshotted once stays one snapshot (dedup against the snapshot itself)', $st === 200 && !isset($o['snapshotId']) && count(pv_load('snap')['versions']) === $n);
// the same page, written back to a stored state, is not re-snapshotted: key order does not matter
[$st, $o] = call('add', 'snap', null, ['origin' => 'manual', 'content' => ['published' => $A, 'draft' => $A]]);
$sx = $o['id'];
call('activate', 'snap', $sx, null);
$n = count(pv_load('snap')['versions']);
[$st, $o] = call('activate', 'snap', $s1, null);
check('a published-only version equals the live state it produced (published = draft)', !isset($o['snapshotId']) && count(pv_load('snap')['versions']) === $n);

// ── 9. delete / active_version / purge ─────────────────────────────────────────
echo "delete and purge\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
$d1 = add('del', ['published' => $A])[1]['id'];
$d2 = add('del', ['published' => $B])[1]['id'];
call('activate', 'del', $d1, null);
[$st, $o] = call('delete', 'del', $d1);
check('the active version cannot be deleted (409 active_version)', $st === 409 && $o['error'] === 'active_version' && pv_find(pv_load('del'), $d1) !== null);
[$st, $o] = call('delete', 'del', $d2);
check('another version can: answer {ok, active}', $st === 200 && $o['ok'] === true && $o['active'] === $d1 && count(pv_load('del')['versions']) === 1);
[$st, $o] = call('delete', 'del', $d2);
check('deleting it twice is 404', $st === 404 && $o['error'] === 'not_found');
call('activate', 'del', add('del', ['published' => $C])[1]['id'], null);
[$st, $o] = call('delete', 'del', $d1);
check('after activating another one the old active can go', $st === 200);
// an only version that is NOT active: deleting it removes the file
rrm(LUMEN_PAGE_VERSIONS_DIR);
$o1 = add('one', ['published' => $A])[1]['id'];
[$st, $o] = call('delete', 'one', $o1);
check('deleting the last version removes the file', $st === 200 && $o['active'] === null && !is_file(LUMEN_PAGE_VERSIONS_DIR . '/one.json'));
[$st, $o] = call('list', 'one');
check('and the page has no history any more', json_encode($o['pages']) === '{}');
add('pg', ['published' => $A]); add('pg', ['published' => $B]);
[$st, $o] = call('purge', 'pg');
check('purge removes the whole history', $st === 200 && $o['ok'] === true && !is_file(LUMEN_PAGE_VERSIONS_DIR . '/pg.json'));
[$st, $o] = call('purge', 'pg');
check('purge is idempotent', $st === 200 && $o['ok'] === true);
$pv = add('keep', ['published' => $A])[1]['id']; call('activate', 'keep', $pv, null);
[$st] = call('purge', 'keep');
check('purge works on a page whose version is active, and leaves the live page alone', $st === 200 && !is_file(LUMEN_PAGE_VERSIONS_DIR . '/keep.json') && live('keep')['published'] === $A);
$k2 = add('keep', ['published' => $B])[1]['id'];
check('the history of a deleted page survives the page, and restores it', (function () use ($k2) {
    site_locked('pages/keep', fn() => site_delete_doc('pages/keep'));
    $gone = live('keep') === [];
    $r = call('activate', 'keep', $k2, null);
    return $gone && $r[0] === 200 && live('keep')['published'] === $GLOBALS['B'];
})());

// ── 10. Limits ─────────────────────────────────────────────────────────────────
echo "limits\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
$cnt = 0;
for ($i = 0; $i < 50; $i++) { [$st] = add('many', ['published' => block('m' . $i)]); if ($st === 200) $cnt++; }
check('50 versions fit', $cnt === 50);
[$st, $o] = add('many', ['published' => $A]);
check('the 51st is 409 too_many_versions', $st === 409 && $o['error'] === 'too_many_versions' && count(pv_load('many')['versions']) === 50);
site_save_checked('pages/many', ['published' => $C], null, null);        // a live state no version captures
$first = pv_load('many')['versions'][0]['id'];
$revBefore = site_rev('pages/many');
[$st, $o] = call('activate', 'many', $first, null);
check('a snapshot that would exceed 50 versions fails the activation and changes nothing', $st === 409 && $o['error'] === 'too_many_versions'
    && site_rev('pages/many') === $revBefore && count(pv_load('many')['versions']) === 50 && pv_load('many')['active'] === null);
[$st, $o] = call('add', 'many', null, ['origin' => 'import', 'content' => ['published' => $A], 'activate' => 'publish']);
check('add + activate over the limit stores nothing', $st === 409 && count(pv_load('many')['versions']) === 50);
// one version over 4 MiB
$big = function (int $n) { return ['sections' => [['id' => 'big', 'columns' => [['width' => 12, 'widgets' => [['type' => 'html', 'html' => str_repeat('x', $n)]]]]]]]; };
$t = []; for ($i = 0; $i < 64; $i++) $t['l' . sprintf('%02d', $i)] = str_repeat('t', 4000);
[$st, $o] = call('add', 'bigv', null, ['origin' => 'import', 'content' => ['title' => $t, 'published' => $big(2000000), 'draft' => $big(2000000)]]);
check('a version over 4 MiB is 413 version_too_large', $st === 413 && $o['error'] === 'version_too_large' && !is_file(LUMEN_PAGE_VERSIONS_DIR . '/bigv.json'));
[$st, $o] = call('add', 'bigv', null, ['origin' => 'import', 'content' => ['published' => $big(2000000), 'draft' => $big(1900000)]]);
check('two blocks of about 2 MiB each are accepted (each block has its own 2 MiB gate)', $st === 200);
call('purge', 'bigv');
$st = 200; $n = 0;
while ($st === 200 && $n < 40) { [$st, $o] = call('add', 'huge', null, ['origin' => 'import', 'label' => 'n' . $n, 'content' => ['published' => $big(1900000 + $n)]]); $n++; }
check('a history over 32 MiB is refused with 413 and the stored file is untouched', $st === 413 && $o['error'] === 'version_too_large' && $n > 10
    && filesize(LUMEN_PAGE_VERSIONS_DIR . '/huge.json') <= PV_MAX_BYTES && count(pv_load('huge')['versions']) === $n - 1);
call('purge', 'huge');
$activateHuge = (function () use ($big) {
    // a snapshot that cannot be stored (file at the limit) fails the activation, nothing changes
    $ids = [];
    $st = 200; $n = 0;
    while ($st === 200 && $n < 40) { [$st, $o] = call('add', 'huge2', null, ['origin' => 'import', 'content' => ['published' => $big(1900000 + $n)]]); if ($st === 200) $ids[] = $o['id']; $n++; }
    site_save_checked('pages/huge2', ['published' => $big(1900000 + 500)], null, null);
    $rev = site_rev('pages/huge2');
    [$st2, $o2] = call('activate', 'huge2', $ids[0], null);
    return [$st2, $o2['error'] ?? '', site_rev('pages/huge2') === $rev];
})();
check('a snapshot over the file limit fails the activation with that error, live page unchanged', $activateHuge === [413, 'version_too_large', true]);
call('purge', 'huge2');

// ── 10a. Review fixes ─────────────────────────────────────────────────────────
echo "review fixes\n";
rrm(LUMEN_PAGE_VERSIONS_DIR);
// add + activate at 49 versions over an unsaved live state: nothing of the added version is stored
for ($i = 0; $i < 49; $i++) add('n49', ['published' => block('q' . $i)]);
site_save_checked('pages/n49', ['published' => $C], null, null);
$revBefore = site_rev('pages/n49');
[$st, $o] = call('add', 'n49', null, ['origin' => 'import', 'content' => ['published' => $A], 'activate' => 'publish']);
check('add + activate at 49 versions over an unsaved live state: 409, nothing stored, page untouched',
    $st === 409 && $o['error'] === 'too_many_versions' && !isset($o['added']) && !isset($o['id'])
    && count(pv_load('n49')['versions']) === 49 && site_rev('pages/n49') === $revBefore);
[$st] = call('add', 'n49', null, ['origin' => 'import', 'content' => ['published' => $C], 'activate' => 'publish']);
check('...while the same add over a live state a version already captures fits (it is the 50th)', $st === 200 && count(pv_load('n49')['versions']) === 50);
rrm(LUMEN_PAGE_VERSIONS_DIR);

// nesting depth: a bound both twins share, checked without recursion
function nest(int $n): array { $v = ['a' => 1]; for ($i = 1; $i < $n; $i++) $v = ['a' => $v]; return $v; }
check('pv_depth counts containers, a scalar is 0', pv_depth(['sections' => [], 'x' => nest(63)], 1000) === 64 && pv_depth(5, 10) === 0 && pv_depth([], 10) === 1);
check('pv_depth stops once past the cap', pv_depth(nest(400), 10) === 11);
[$st] = call('add', 'deep', null, ['origin' => 'manual', 'content' => ['published' => ['sections' => [], 'x' => nest(PV_MAX_DEPTH - 1)]]]);
check('a block nested exactly PV_MAX_DEPTH deep is stored', $st === 200);
[$st, $o] = call('add', 'deep', null, ['origin' => 'manual', 'content' => ['published' => ['sections' => [], 'x' => nest(PV_MAX_DEPTH)]]]);
check('a block one level deeper is 400 invalid_content and not stored', $st === 400 && $o['error'] === 'invalid_content' && count(pv_load('deep')['versions']) === 1);
[$st, $o] = call('add', 'deep', null, ['origin' => 'manual', 'content' => ['published' => ['sections' => [], 'x' => nest(450)]]]);
check('a block 450 deep is refused the same way', $st === 400 && $o['error'] === 'invalid_content' && count(pv_load('deep')['versions']) === 1);
call('purge', 'deep');

// a live page the structural gate would refuse is still snapshotted and restorable
site_save_doc('pages/dmg', ['published' => ['sections' => [['columns' => 'x']]], 'schemaVersion' => 2]);
$dmgV = add('dmg', ['published' => $A])[1]['id'];
[$st, $o] = call('activate', 'dmg', $dmgV, null);
$h = pv_load('dmg');
$snap = is_string($o['snapshotId'] ?? null) ? $h['versions'][pv_find($h, $o['snapshotId'])] : null;
check('a live page with an invalid column list is snapshotted as it is, then replaced',
    $st === 200 && $snap !== null && cj($snap['content']['published']) === cj(['sections' => [['columns' => 'x']]]) && live('dmg')['published'] === $A);
site_save_doc('pages/dmg', ['published' => ['sections' => [['columns' => 'x']]], 'schemaVersion' => 2]);
[$st, $o] = call('update', 'dmg', $dmgV, ['fromLive' => true]);
check('"update from live" over it succeeds too', $st === 200 && $o['version']['widgets'] === 0);
$filesBefore = [@file_get_contents(LUMEN_CONFIG_DIR . '/pages/dmg.json'), count(pv_load('dmg')['versions'])];
[$st, $o] = call('activate', 'dmg', $dmgV, null);
check('a version captured from a damaged page is kept, never shown: activating it is 400 and nothing moves',
    $st === 400 && $o['error'] === 'invalid_content' && $filesBefore === [@file_get_contents(LUMEN_CONFIG_DIR . '/pages/dmg.json'), count(pv_load('dmg')['versions'])]);
$dmgV = add('dmg', ['published' => $A])[1]['id'];
$wide = block('wd'); $wide['sections'][0]['columns'][0]['width'] = 99;
site_save_doc('pages/dmg', ['published' => $wide, 'schemaVersion' => 2]);
[$st, $o] = call('activate', 'dmg', $dmgV, null);
$h = pv_load('dmg');
check('a live column of width 99 is kept as it is in the snapshot', $st === 200 && is_string($o['snapshotId'] ?? null)
    && $h['versions'][pv_find($h, $o['snapshotId'])]['content']['published']['sections'][0]['columns'][0]['width'] === 99);
call('purge', 'dmg');

// a legacy plain-string title is not carried into a snapshot (the Python twin drops it too)
site_save_doc('pages/lt', ['title' => 'Plain title', 'published' => block('lt', 'Live'), 'schemaVersion' => 2]);
$ltV = add('lt', ['published' => $A])[1]['id'];
[$st, $o] = call('activate', 'lt', $ltV, null);
$h = pv_load('lt');
check('a legacy string title is left out of the safety snapshot', $st === 200 && !array_key_exists('title', $h['versions'][pv_find($h, $o['snapshotId'])]['content']));
call('purge', 'lt');

// a live title is kept when the version activated carries another one
$tp = add('tt', ['published' => $A])[1]['id'];
$tt = add('tt', ['published' => $B, 'title' => ['en' => 'Y']])[1]['id'];
site_save_doc('pages/tt', ['title' => ['en' => 'Live X'], 'published' => $A, 'draft' => $A, 'schemaVersion' => 2]);
[$st, $o] = call('activate', 'tt', $tt, null);
$h = pv_load('tt');
check('a live title no version holds is snapshotted before another title replaces it', $st === 200 && is_string($o['snapshotId'] ?? null)
    && cj($h['versions'][pv_find($h, $o['snapshotId'])]['content']['title']) === cj(['en' => 'Live X']));
site_save_doc('pages/tt', ['title' => ['en' => 'Live X'], 'published' => $A, 'draft' => $A, 'schemaVersion' => 2]);
[$st, $o] = call('activate', 'tt', $tp, null);
check('a title-less version leaves the live title alone: no snapshot for it', $st === 200 && !isset($o['snapshotId']));
call('purge', 'tt');

// activation normalizes a legacy layout even when the page already shows the version
$lg = add('lg', ['published' => $A])[1]['id'];
@mkdir(LUMEN_CONFIG_DIR . '/pages', 0777, true);
file_put_contents(LUMEN_CONFIG_DIR . '/pages/lg.json', json_encode(['published' => $A, 'draft' => $A]));
call('activate', 'lg', $lg, null);
$pub = json_decode((string)file_get_contents(LUMEN_CONFIG_DIR . '/pages/lg.json'), true);
check('a legacy inline draft moves to the private file and schemaVersion is stamped', !isset($pub['draft']) && ($pub['schemaVersion'] ?? null) === 2 && is_file(LUMEN_PAGE_DRAFTS_DIR . '/lg.json'));
$revBefore = site_rev('pages/lg');
call('activate', 'lg', $lg, null);
check('...and a page already in the editor layout is not rewritten', site_rev('pages/lg') === $revBefore);
call('purge', 'lg');

// sizes: oversize is 413 whatever the escaping, a slash is not counted twice
$wideTxt = ['sections' => [['id' => 's', 'columns' => [['id' => 'c', 'width' => 12, 'widgets' => [['type' => 'text', 'props' => ['body' => str_repeat("\u{e9}", 400000)]]]]]]]];
[$st, $o] = call('add', 'esc', null, ['origin' => 'manual', 'content' => ['published' => $wideTxt]]);
check('a block that only the JSON escaping makes oversize is 413 version_too_large', $st === 413 && $o['error'] === 'version_too_large');
$slashTxt = ['sections' => [['id' => 's', 'columns' => [['id' => 'c', 'width' => 12, 'widgets' => [['type' => 'text', 'props' => ['body' => str_repeat('/', 1100000)]]]]]]]];
[$st] = call('add', 'esc', null, ['origin' => 'manual', 'content' => ['published' => $slashTxt]]);
check('1.1 million slashes fit (a slash is one character, as in the Python twin)', $st === 200);
call('purge', 'esc');

// `sections: null` beside a list of blocks is the legacy shape
[$st] = call('add', 'nul', null, ['origin' => 'manual', 'content' => ['published' => ['sections' => null, 'blocks' => [['type' => 'heading', 'props' => new stdClass()]]]]]);
check('sections: null beside blocks is accepted', $st === 200);
[$st, $o] = call('add', 'nul', null, ['origin' => 'manual', 'content' => ['published' => ['sections' => null]]]);
check('sections: null alone is 400 invalid_content', $st === 400 && $o['error'] === 'invalid_content');
call('purge', 'nul');

// ── 10b. Concurrent writers ────────────────────────────────────────────────────
echo "concurrency\n";
if (function_exists('proc_open')) {
    $worker = "$root/worker.php";
    file_put_contents($worker, "<?php\ndeclare(strict_types=1);\n"
        . "define('LUMEN_PRIVATE_DIR', " . var_export($root, true) . ");\n"
        . "define('LUMEN_CONFIG_DIR', " . var_export(LUMEN_CONFIG_DIR, true) . ");\n"
        . "define('LUMEN_PAGE_DRAFTS_DIR', " . var_export(LUMEN_PAGE_DRAFTS_DIR, true) . ");\n"
        . "define('LUMEN_PAGE_VERSIONS_DIR', " . var_export(LUMEN_PAGE_VERSIONS_DIR, true) . ");\n"
        . "define('LUMEN_PV_LIB', true);\nrequire " . var_export(__DIR__ . '/../api/page-versions.php', true) . ";\n"
        . "\$w = (int)\$argv[1];\n"
        . "for (\$i = 0; \$i < 8; \$i++) {\n"
        . "  \$b = lumen_json_decode_doc(json_encode(['origin' => 'import', 'label' => \"w\$w-\$i\", 'activate' => (\$i % 2 ? 'publish' : null),\n"
        . "    'content' => ['published' => ['sections' => [['id' => \"w\$w-\$i\"]]]]]));\n"
        . "  [\$st] = pv_handle('add', 'race', null, \$b);\n"
        . "  if (\$st !== 200) { fwrite(STDERR, \"status \$st\n\"); exit(3); }\n"
        . "}\n");
    rrm(LUMEN_PAGE_VERSIONS_DIR);
    $procs = [];
    for ($w = 0; $w < 3; $w++) {
        $procs[] = proc_open([PHP_BINARY, $worker, (string)$w], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pp);
    }
    $codes = [];
    foreach ($procs as $p) { $codes[] = proc_close($p); }
    $h = pv_load('race');
    $labels = array_column($h['versions'], 'label');
    $mine = array_filter($labels, function ($l) { return $l[0] === 'w'; });
    check('three processes adding (and activating) at once lose no version, the file stays valid',
        $codes === [0, 0, 0] && $h['state'] === 'ok' && count($mine) === 24 && count(array_unique(array_column($h['versions'], 'id'))) === count($h['versions']));
} else {
    echo "  SKIP concurrency (proc_open unavailable)\n";
}

// ── 11. Corrupt / foreign storage ──────────────────────────────────────────────
echo "storage robustness\n";
@mkdir(LUMEN_PAGE_VERSIONS_DIR, 0777, true);
file_put_contents(LUMEN_PAGE_VERSIONS_DIR . '/bad.json', '{not json');
[$st, $o] = call('list', 'bad');
check('a corrupt file reads as no history', $st === 200 && json_encode($o['pages']) === '{}');
[$st, $o] = add('bad', ['published' => $A]);
$parked = glob(LUMEN_PAGE_VERSIONS_DIR . '/bad.corrupt-*.json') ?: [];
check('a write over a corrupt file parks it aside (as *.json, still denied over HTTP) and starts clean', $st === 200 && count($parked) === 1 && pv_load('bad')['state'] === 'ok');
check('a parked file is not listed as a page', count(array_filter(pv_all_slugs(), function ($s) { return strpos($s, 'corrupt') !== false; })) === 0);
file_put_contents(LUMEN_PAGE_VERSIONS_DIR . '/future.json', json_encode(['schema' => 'lumen-page-versions/9', 'slug' => 'future', 'active' => null, 'versions' => []]));
[$st, $o] = add('future', ['published' => $A]);
check('a history of a newer schema is never overwritten', $st === 500 && $o['error'] === 'write_failed' && (json_decode((string)file_get_contents(LUMEN_PAGE_VERSIONS_DIR . '/future.json'), true)['schema'] ?? '') === 'lumen-page-versions/9');
$mix = ['schema' => PV_SCHEMA, 'slug' => 'mix', 'active' => 'v999999999999', 'versions' => [
    'junk', ['id' => 'nope'], ['id' => 'v0123456789ab', 'label' => 5, 'content' => ['published' => $A]], ['id' => 'v0123456789ab', 'content' => ['published' => $B]],
    ['id' => 'v0123456789ac', 'label' => 'ok', 'origin' => 'weird', 'content' => ['published' => $B]], ['id' => 'v0123456789ad', 'content' => 'x']]];
file_put_contents(LUMEN_PAGE_VERSIONS_DIR . '/mix.json', json_encode($mix));
$h = pv_load('mix');
check('a history holding a malformed version, a repeated id or a foreign slug is unreadable as a whole (corrupt), never half-read', $h['state'] === 'corrupt' && $h['versions'] === []);
foreach ([['get', 404], ['list', 200]] as [$a, $want]) { $r = pv_handle($a, 'mix', $a === 'get' ? 'v0123456789ab' : null, null); if ($r[0] !== $want) check("reading a damaged file with $a", false); }
check('reading a damaged file never fails', true);

// ── 12. Protect lists, release build, denial ───────────────────────────────────
echo "protect lists\n";
check('admin_is_data_rel covers api/page-versions', admin_is_data_rel('api/page-versions') && admin_is_data_rel('api/page-versions/about.json') && admin_is_data_rel('api/page-drafts/x.json') && !admin_is_data_rel('api/page-versionsX'));
check('an update never overwrites the histories', admin_update_protected('api/page-versions/about.json') && admin_update_protected('api/page-drafts/about.json') && !admin_update_protected('api/page-versions.php'));
$inst = (string)file_get_contents(__DIR__ . '/../install.php');
check('install.php protects api/page-versions', strpos($inst, "'api/page-drafts', 'api/page-versions'") !== false);
$br = (string)file_get_contents(__DIR__ . '/../tools/build_release.py');
check('build_release.py lists page-versions as a runtime dir (never shipped)', preg_match('/API_RUNTIME_DIRS\s*=\s*frozenset\(\{[^}]*"page-versions"/', $br) === 1);
$gi = preg_split('/\r?\n/', (string)file_get_contents(__DIR__ . '/../.gitignore'));
check('.gitignore keeps the histories (unpublished drafts) out of a commit, like api/page-drafts/', in_array('api/page-versions/', $gi, true) && in_array('api/page-drafts/', $gi, true));
$ht = (string)file_get_contents(__DIR__ . '/../api/.htaccess');
$router = (string)file_get_contents(__DIR__ . '/../router.php');
check('api/.htaccess denies every *.json and every _*.php below api/ (the history files, the library)', strpos($ht, '\.json$') !== false && strpos($ht, '^_[A-Za-z0-9_]+\.php$') !== false);
check('router.php denies /api/**/*.json and /api/_*.php', strpos($router, "#^/api/.*\\.json\$#i") !== false && strpos($router, '_[A-Za-z0-9_]+\.php') !== false);
check('the history lives under api/, which dev_server.py never serves', strpos((string)file_get_contents(__DIR__ . '/../dev_server.py'), '_FORBIDDEN_ROOTS = frozenset({"api"') !== false);
$ep = (string)file_get_contents(__DIR__ . '/../api/page-versions.php');
check('the entry point requires _bootstrap.php guarded, releases the session and answers 401 first', strpos($ep, "is_file(__DIR__ . '/_bootstrap.php')") !== false
    && strpos($ep, 'session_write_close()') !== false && strpos($ep, 'session_write_close()') < strpos($ep, 'admin_is_auth()') && strpos($ep, 'admin_is_auth()') < strpos($ep, 'admin_require_write()'));

// ── 13. The entry point over HTTP (php -S) ────────────────────────────────────
echo "entry point (php -S)\n";
$phpBin = PHP_BINARY;
$http = null;
if (function_exists('proc_open') && $phpBin !== '') {
    // a session the entry point will accept: same private dir, same credential file
    admin_write_json(LUMEN_CRED_FILE, ['version' => 1, 'username' => 'admin', 'password_pbkdf2' => 'x', 'created' => 't', 'rotated' => 't']);
    $sid = 'pvtest' . bin2hex(random_bytes(12));
    $csrf = 'csrf-' . bin2hex(random_bytes(8));
    $sessDir = admin_session_dir();
    // PHP's default session serializer: name|serialize(value) for each key
    $sessData = 'admin_authenticated|' . serialize(true) . 'admin_user|' . serialize('admin') . 'auth_at|' . serialize(time())
        . 'cred_stamp|' . serialize(admin_credential_stamp()) . 'csrf|' . serialize($csrf);
    if ($sessDir !== null) file_put_contents("$sessDir/sess_$sid", $sessData);
    $prep = "$root/prepend.php";
    file_put_contents($prep, "<?php\n"
        . "define('LUMEN_PRIVATE_DIR', " . var_export($root, true) . ");\n"
        . "define('LUMEN_CRED_FILE', " . var_export(LUMEN_CRED_FILE, true) . ");\n"
        . "define('LUMEN_CONFIG_DIR', " . var_export(LUMEN_CONFIG_DIR, true) . ");\n"
        . "define('LUMEN_PAGE_DRAFTS_DIR', " . var_export(LUMEN_PAGE_DRAFTS_DIR, true) . ");\n"
        . "define('LUMEN_PAGE_VERSIONS_DIR', " . var_export(LUMEN_PAGE_VERSIONS_DIR, true) . ");\n");
    $srv = @stream_socket_server('tcp://127.0.0.1:0', $en, $es);
    $port = 0;
    if ($srv) { $port = (int)substr((string)strrchr((string)stream_socket_get_name($srv, false), ':'), 1); fclose($srv); }
    if ($port > 0) {
        $server = proc_open([$phpBin, '-d', 'auto_prepend_file=' . $prep, '-d', 'display_errors=0', '-S', "127.0.0.1:$port", '-t', dirname(__DIR__)],
            [0 => ['pipe', 'r'], 1 => ['file', "$root/server.out", 'w'], 2 => ['file', "$root/server.err", 'w']], $pipes);
        for ($i = 0; $i < 50 && is_resource($server); $i++) {
            $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2);
            if ($c) { fclose($c); $http = "http://127.0.0.1:$port"; break; }
            usleep(100000);
        }
    }
}
if ($http === null) {
    echo "  SKIP the HTTP part (php -S could not be started here)\n";
} else {
    $req = function (string $method, string $query, $body = null, array $hdr = [], bool $auth = true) use ($http, $sid, $csrf): array {
        $h = ['Cookie: iribhm_admin=' . $sid];
        if (!$auth) $h = [];
        if ($body !== null) $h[] = 'Content-Type: application/json';
        $h = array_merge($h, $hdr);
        $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $h), 'content' => $body === null ? '' : (is_string($body) ? $body : json_encode($body)),
                                                'ignore_errors' => true, 'timeout' => 30]]);
        $raw = @file_get_contents($http . '/api/page-versions.php?' . $query, false, $ctx);
        $status = 0; $headers = [];
        foreach ((array)($http_response_header ?? []) as $line) {
            if (preg_match('#^HTTP/\S+ (\d+)#', $line, $m)) $status = (int)$m[1];
            elseif (strpos($line, ':') !== false) { [$k, $v] = explode(':', $line, 2); $headers[strtolower(trim($k))] = trim($v); }
        }
        return [$status, json_decode((string)$raw, true), $headers, (string)$raw];
    };
    $tok = ['X-CSRF-Token: ' . $csrf];
    [$st, $j] = $req('GET', 'action=list', null, [], false);
    check('anonymous GET list → 401 Not authenticated', $st === 401 && ($j['error'] ?? '') === 'Not authenticated');
    [$st, $j] = $req('POST', 'action=purge&slug=x', '{}', [], false);
    check('anonymous POST → 401', $st === 401);
    [$st, $j] = $req('GET', 'action=bogus', null, [], false);
    check('anonymous + unknown action → still 401 (authentication first)', $st === 401);
    [$st, $j, $hd] = $req('GET', 'action=list');
    check('admin list → 200, no-store', $st === 200 && ($j['schema'] ?? '') === 'lumen-page-versions/1' && stripos($hd['cache-control'] ?? '', 'no-store') !== false);
    [$st, $j] = $req('GET', 'action=bogus');
    check('unknown action → 400 Unknown action', $st === 400 && ($j['error'] ?? '') === 'Unknown action');
    [$st, $j] = $req('GET', 'action=add&slug=web', '{}');
    check('a write sent as GET → 405', $st === 405);
    [$st, $j] = $req('POST', 'action=add&slug=web', '{"origin":"import","content":{"published":{"sections":[]}}}');
    check('a write without CSRF token → 403', $st === 403 && !is_file(LUMEN_PAGE_VERSIONS_DIR . '/web.json'));
    [$st, $j] = $req('POST', 'action=add&slug=web', '{"origin":"import","content":{"published":{"sections":[]}}}', ['X-CSRF-Token: wrong']);
    check('a write with a wrong CSRF token → 403', $st === 403);
    [$st, $j] = $req('POST', 'action=add&slug=web', '{"origin":', $tok);
    check('garbage JSON → 400 invalid_body', $st === 400 && ($j['error'] ?? '') === 'invalid_body');
    [$st, $j] = $req('POST', 'action=add&slug=web', '{"origin":"import","label":"Web","content":{"title":{},"published":{"sections":[]}},"activate":"publish"}', $tok);
    $wid = $j['id'] ?? '';
    check('add + activate over HTTP', $st === 200 && ($j['ok'] ?? false) === true && preg_match(PV_ID_RX, $wid) === 1 && ($j['version']['isActive'] ?? false) === true);
    check('...the file is on disk and the page is live', is_file(LUMEN_PAGE_VERSIONS_DIR . '/web.json') && is_file(LUMEN_CONFIG_DIR . '/pages/web.json'));
    [$st, $j, $hd, $raw] = $req('GET', "action=get&slug=web&id=$wid");
    check('get over HTTP keeps `{}` as an object in the body', $st === 200 && strpos($raw, '"title":{}') !== false);
    [$st, $j, $hd, $raw] = $req('GET', 'action=list&slug=web');
    check('list answers a version META', $st === 200 && ($j['pages']['web']['versions'][0]['id'] ?? '') === $wid && ($j['pages']['web']['active'] ?? '') === $wid);
    [$st, $j] = $req('GET', 'action=list&slug=..%2Fx');
    check('a traversal slug over HTTP → 400 invalid_slug', $st === 400 && ($j['error'] ?? '') === 'invalid_slug');
    [$st, $j] = $req('POST', "action=delete&slug=web&id=$wid", '', $tok);
    check('delete of the active version over HTTP → 409', $st === 409 && ($j['error'] ?? '') === 'active_version');
    [$st, $j] = $req('POST', "action=update&slug=web&id=$wid", '{"label":"Renamed"}', $tok);
    check('update over HTTP', $st === 200 && ($j['version']['label'] ?? '') === 'Renamed');
    [$st, $j] = $req('POST', 'action=purge&slug=web', '', $tok);
    check('purge over HTTP', $st === 200 && !is_file(LUMEN_PAGE_VERSIONS_DIR . '/web.json'));
    [$st, $j, $hd, $raw] = $req('GET', 'action=list');
    check('no PHP error text ever reaches a body', strpos($raw, 'Warning') === false && strpos($raw, 'Notice') === false && strpos($raw, 'Deprecated') === false);
    $err = (string)@file_get_contents("$root/server.err");
    // Only what the platform's own files raised counts: a host php.ini can print startup
    // notices of its own (deprecated directives, a module loaded twice) that no request caused.
    $ours = array_values(array_filter(preg_split('/\R/', $err) ?: [], static function ($line) {
        return preg_match('/PHP (Warning|Notice|Deprecated|Fatal|Parse)/', $line)
            && (strpos($line, '/api/') !== false || strpos($line, '\\api\\') !== false);
    }));
    check('and the server logged no PHP error for any of it' . ($ours ? ': ' . implode(' | ', array_slice($ours, 0, 3)) : ''), !$ours);
}

// ── Done ───────────────────────────────────────────────────────────────────────
restore_error_handler();
check('no warning, notice or deprecation was raised by any of the above' . ($noise ? ': ' . implode(' | ', array_slice($noise, 0, 5)) : ''), !$noise);
echo $fails ? "FAILED ($fails)\n" : "OK\n";
exit($fails ? 1 : 0);
