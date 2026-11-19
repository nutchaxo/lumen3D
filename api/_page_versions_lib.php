<?php
/**
 * Lumen3D — page version history (PHP twin of dev_server.py's _pv_* helpers).
 *
 * A page (a slug: home, about, a custom page) keeps up to PV_MAX_VERSIONS immutable-by-default
 * snapshots of its content in api/page-versions/<slug>.json (0600, never web-served: the whole
 * api/ tree is denied by api/.htaccess, router.php and the root .htaccess). One version is
 * "active" — the last one activated in publish mode. The history outlives the page itself,
 * which is how a deleted page is restored. Contract: DOCS/pages-library/SPEC.md §2, §3.
 *
 * File format (identical on both backends, so a host may switch backend):
 *   { "schema": "lumen-page-versions/1", "slug", "active": id|null,
 *     "versions": [ { id, label, note, origin, createdAt, updatedAt, exportedAt, source,
 *                     platform, content: { title?, nav?, published?, draft? } } … ] }   oldest first
 *
 * Lock order, always: the site doc lock (site_locked) FIRST, then the history lock. A new
 * code path that needs both must follow it, or two requests deadlock each other.
 *
 * Library mode (tests): define('LUMEN_PV_LIB', true) before including api/page-versions.php —
 * the helpers below are defined, nothing is routed and no session is touched.
 * LUMEN_PAGE_VERSIONS_DIR points the storage elsewhere (like LUMEN_PAGE_DRAFTS_DIR).
 *
 * Leading underscore => denied over HTTP by api/.htaccess and router.php.
 * Kept compatible with the PHP 7.4 floor of the platform.
 */
declare(strict_types=1);

if (!defined('LUMEN_SITE_LIB')) define('LUMEN_SITE_LIB', true);
require_once __DIR__ . '/_admin_lib.php';
require_once __DIR__ . '/site.php';

const PV_SCHEMA = 'lumen-page-versions/1';
const PV_MAX_VERSIONS = 50;
const PV_MAX_BYTES = 33554432;      // one stored history file
const PV_MAX_CONTENT = 4194304;     // the blocks of one version together
const PV_MAX_BLOCK = 2097152;       // one block, like a page doc
const PV_TOO_LARGE = 'too_large';   // what pv_check_block / pv_normalize_content answer for a block over PV_MAX_BLOCK
const PV_MAX_DEPTH = 64;            // nesting of one block: far above what the editor writes, far below any parser's stack
const PV_MAX_LOCALES = 64;          // locales of one localized value (title, nav label)
const PV_MAX_LOCALIZED = 4000;      // characters of one localized string
const PV_MAX_BODY = 50331648;       // a request body (a version + headroom); above it nothing is decoded
const PV_ORIGINS = ['import', 'capture', 'auto', 'manual'];
const PV_SLUG_RX = '/^[a-z0-9][a-z0-9_-]{0,63}\z/';
const PV_ID_RX = '/^v[0-9a-f]{12}\z/';

function pv_dir(): string { return defined('LUMEN_PAGE_VERSIONS_DIR') ? (string)LUMEN_PAGE_VERSIONS_DIR : __DIR__ . '/page-versions'; }

function pv_slug_ok($slug): bool { return is_string($slug) && preg_match(PV_SLUG_RX, $slug) === 1; }
function pv_id_ok($id): bool { return is_string($id) && preg_match(PV_ID_RX, $id) === 1; }

/** The history file of a page; null for anything that is not a plain slug (no traversal is ever possible). */
function pv_path(string $slug): ?string {
    return pv_slug_ok($slug) ? pv_dir() . '/' . $slug . '.json' : null;
}

function pv_now(): string { return gmdate('Y-m-d\TH:i:s\Z'); }

/** [status, {"error": code, …extra}] */
function pv_err(int $status, string $code, array $extra = []): array {
    return [$status, array_merge(['error' => $code], $extra)];
}

// ── Text fields ──────────────────────────────────────────────────────────────

function pv_truncate(string $s, int $max): string {
    if (function_exists('mb_substr')) return mb_substr($s, 0, $max, 'UTF-8');
    return preg_match('/^.{0,' . $max . '}/su', $s, $m) === 1 ? $m[0] : substr($s, 0, $max);
}

/**
 * A client text: control characters out, trimmed, cut to $max characters, trimmed again.
 * $mode 'label' = one line (a tab / line break inside becomes a space), 'info' = one line
 * (they vanish), 'note' = tabs and line feeds kept. Only ASCII white space is trimmed,
 * as the Python twin does.
 */
function pv_clean_text(string $s, int $max, string $mode = 'label'): string {
    if ($mode === 'note') {
        $s = (string)preg_replace('/[\x00-\x08\x0B-\x1F\x7F]/', '', $s);
    } else {
        if ($mode === 'label') $s = (string)preg_replace('/[\t\r\n]+/', ' ', $s);
        $s = (string)preg_replace('/[\x00-\x1F\x7F]/', '', $s);
    }
    return trim(pv_truncate(trim($s), $max));
}

/** A text field of a request body: null = absent, false = present but not a string. */
function pv_field(array $b, string $key, int $max, string $mode = 'label') {
    if (!array_key_exists($key, $b) || $b[$key] === null) return null;
    if (!is_string($b[$key])) return false;
    return pv_clean_text($b[$key], $max, $mode);
}

// ── Canonical form (equality of two states, key order ignored) ───────────────

function pv_canon($v, bool $forceObject = false) {
    if ($v instanceof stdClass) { $v = get_object_vars($v); $forceObject = true; }
    if (!is_array($v)) return $v;
    if (!$forceObject && lumen_json_is_list($v)) {
        $out = [];
        foreach ($v as $x) $out[] = pv_canon($x);
        return $out;
    }
    $keys = array_map('strval', array_keys($v));
    sort($keys, SORT_STRING);
    $o = new stdClass();
    foreach ($keys as $k) $o->{$k} = pv_canon($v[$k]);
    return $o;
}

function pv_canon_json($v): string {
    $j = json_encode(pv_canon($v), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return is_string($j) ? $j : '';
}

// ── Content: validation + shape ──────────────────────────────────────────────

/** Length in characters (code points), as the Python twin counts. */
function pv_ulen(string $s): int {
    if (function_exists('mb_strlen')) return mb_strlen($s, 'UTF-8');
    return (int)preg_match_all('/./su', $s);
}

/** A localized value: an object of locale → string (SPEC §1), at most 32 locales, 2000 characters a value. Normalized (`{}` for an empty one), or false when invalid. */
function pv_localized($v) {
    if ($v instanceof stdClass && !get_object_vars($v)) return new stdClass();
    if (!lumen_json_is_object($v)) return false;
    $a = site_as_array($v);
    if (count($a) > PV_MAX_LOCALES) return false;
    foreach ($a as $k => $x) {
        if (preg_match('/^[A-Za-z0-9_-]{1,16}\z/', (string)$k) !== 1) return false;
        if (!is_string($x) || pv_ulen($x) > PV_MAX_LOCALIZED) return false;
    }
    return $v instanceof stdClass ? $v : $a;
}

/**
 * Nesting depth of $v (a scalar is 0, a container 1 + its deepest child), walked without recursion and
 * stopped once it passes $cap. Twin of dev_server.py _pv_depth.
 */
function pv_depth($v, int $cap): int {
    $stack = [[$v, 1]];
    $deepest = 0;
    while ($stack) {
        [$node, $d] = array_pop($stack);
        if ($node instanceof stdClass) $node = get_object_vars($node);
        if (!is_array($node)) continue;
        if ($d > $deepest) $deepest = $d;
        if ($d > $cap) return $d;
        foreach ($node as $child) {
            if ($child instanceof stdClass || is_array($child)) $stack[] = [$child, $d + 1];
        }
    }
    return $deepest;
}

/** Structural gate of one block (the page-doc gate of site_validate_page on a probe holding it alone,
 *  so each block gets the sections / columns / widgets limits, and PV_MAX_BLOCK bytes). Error text, PV_TOO_LARGE or null; $b is the clamped block. */
function pv_check_block(&$b, string $key): ?string {
    if (!lumen_json_is_object($b) || !is_array($b)) return "'$key' must be an object holding sections or blocks";
    // `sections: null` beside a list of blocks is the legacy shape, as in the Python twin.
    if (array_key_exists('sections', $b) && ($b['sections'] !== null || !array_key_exists('blocks', $b))) {
        if (!lumen_json_is_list($b['sections'])) return "'$key' has invalid sections";
    } elseif (array_key_exists('blocks', $b)) {
        if (!lumen_json_is_list($b['blocks']) || count($b['blocks']) > 500) return "'$key' has invalid blocks";
        foreach ($b['blocks'] as $w) {
            if (!is_array($w) || !isset($w['type']) || !is_string($w['type'])) return "'$key' has an invalid block";
        }
    } else {
        return "'$key' holds neither sections nor blocks";
    }
    if (pv_depth($b, PV_MAX_DEPTH) > PV_MAX_DEPTH) return "'$key' is nested too deeply";
    if (pv_content_bytes($b) > PV_MAX_BLOCK) return PV_TOO_LARGE;
    $probe = [$key => $b];
    $err = site_validate_page($probe);
    if ($err === 'Page document too large') return PV_TOO_LARGE;
    if ($err !== null) return $err;
    $b = $probe[$key];
    return null;
}

/**
 * The content of a version, validated and reduced to its four known members in storage order
 * (title, nav, published, draft). [content, null] or [null, detail].
 */
function pv_normalize_content($content): array {
    if (!lumen_json_is_object($content)) return [null, 'content must be an object'];
    $c = site_as_array($content);
    $out = [];
    if (array_key_exists('title', $c) && $c['title'] !== null) {
        $t = pv_localized($c['title']);
        if ($t === false) return [null, 'invalid title'];
        $out['title'] = $t;
    }
    if (array_key_exists('nav', $c) && $c['nav'] !== null) {
        if (!lumen_json_is_object($c['nav'])) return [null, 'invalid nav'];
        $n = site_as_array($c['nav']);
        $nav = [];
        if (array_key_exists('label', $n) && $n['label'] !== null) {
            $l = pv_localized($n['label']);
            if ($l === false) return [null, 'invalid nav label'];
            $nav['label'] = $l;
        }
        if (array_key_exists('show', $n) && $n['show'] !== null) {
            if (!is_bool($n['show'])) return [null, 'invalid nav show'];
            $nav['show'] = $n['show'];
        }
        $out['nav'] = $nav ?: new stdClass();
    }
    $blocks = 0;
    foreach (['published', 'draft'] as $key) {
        if (!array_key_exists($key, $c) || $c[$key] === null) continue;
        $b = $c[$key];
        $err = pv_check_block($b, $key);
        if ($err !== null) return [null, $err];
        $out[$key] = $b;
        $blocks++;
    }
    if ($blocks === 0) return [null, 'content needs a published or a draft block'];
    return [$out, null];
}

/** The refusal for a pv_normalize_content / pv_check_block verdict. */
function pv_content_err(string $detail): array {
    return $detail === PV_TOO_LARGE ? pv_err(413, 'version_too_large') : pv_err(400, 'invalid_content', ['detail' => $detail]);
}

function pv_content_bytes($content): int {
    // U+2028 / U+2029 stay raw, as JSON.stringify and the Python twin count them (PHP escapes them by default).
    $j = json_encode($content, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS);
    return is_string($j) ? strlen($j) : PHP_INT_MAX;
}

/** A block of a content array when it has the shape of one, else null. */
function pv_block(array $c, string $key): ?array {
    $b = $c[$key] ?? null;
    if (!is_array($b) || !lumen_json_is_object($b)) return null;
    foreach (['sections', 'blocks'] as $k) {
        if (array_key_exists($k, $b) && lumen_json_is_list($b[$k])) return $b;
    }
    return null;
}

/** A page title worth writing: a non-empty string or a non-empty localized object; else null. */
function pv_title_value($t) {
    if (is_string($t)) return trim($t) === '' ? null : $t;
    if (lumen_json_is_object($t) && is_array($t)) return $t;
    return null;
}

/** A live title worth keeping in a snapshot: a non-empty localized object a stored title could be. A legacy plain-string title is dropped (the Python twin does the same). */
function pv_live_title($t) {
    if (!lumen_json_is_object($t) || !is_array($t)) return null;
    return pv_localized($t) === false ? null : $t;
}

/**
 * What a page is made of right now, as a content array (title?, published?, draft?) — the live
 * state of an admin read (site_load_admin) — or null when it holds no block at all. Blocks are
 * taken as they are: a snapshot must never be refused because of legacy data.
 */
function pv_live_content(array $doc): ?array {
    $out = [];
    $t = pv_live_title($doc['title'] ?? null);
    if ($t !== null) $out['title'] = $t;
    $has = false;
    foreach (['published', 'draft'] as $key) {
        $b = pv_block($doc, $key);
        if ($b !== null) { $out[$key] = $b; $has = true; }
    }
    return $has ? $out : null;
}

/**
 * What activating a version in publish mode shows (published ?? draft) and what the editor holds
 * (draft ?? published), plus the title: two contents that share this signature are the same page
 * for the reader and for the editor, whichever half they spelled out. $withTitle false leaves the
 * title out — activating a version that has none leaves the live title alone, so such a version
 * is the live page whatever its title.
 */
function pv_signature(array $c, bool $withTitle = true): string {
    $pub = pv_block($c, 'published');
    $dr = pv_block($c, 'draft');
    if ($pub === null && $dr === null) return '';
    $t = $withTitle ? pv_title_value($c['title'] ?? null) : null;
    return pv_canon_json(['title' => $t === null ? new stdClass() : $t, 'published' => $pub ?? $dr, 'draft' => $dr ?? $pub]);
}

// ── META (what a list shows, never the content) ──────────────────────────────

function pv_widget_count(array $b): int {
    if (lumen_json_is_list($b['blocks'] ?? null) && array_key_exists('blocks', $b)) return count($b['blocks']);
    $n = 0;
    $secs = $b['sections'] ?? null;
    if (!is_array($secs)) return 0;
    foreach ($secs as $s) {
        $cols = is_array($s) ? ($s['columns'] ?? null) : null;
        if (!is_array($cols)) continue;
        foreach ($cols as $c) {
            $w = is_array($c) ? ($c['widgets'] ?? null) : null;
            if (is_array($w)) $n += count($w);
        }
    }
    return $n;
}

/** Locales a block is written in: the keys of every object whose keys are all 2-letter codes over string values. */
function pv_collect_locales($v, array &$locs): void {
    if ($v instanceof stdClass) $v = get_object_vars($v);
    if (!is_array($v) || !$v) return;
    if (lumen_json_is_list($v)) {
        foreach ($v as $x) pv_collect_locales($x, $locs);
        return;
    }
    $all = true;
    foreach ($v as $k => $x) {
        if (preg_match('/^[a-z]{2}\z/', (string)$k) !== 1 || !is_string($x)) { $all = false; break; }
    }
    if ($all) {
        foreach ($v as $k => $x) $locs[(string)$k] = true;
        return;
    }
    foreach ($v as $x) pv_collect_locales($x, $locs);
}

function pv_meta(array $v, ?string $active): array {
    $c = site_as_array($v['content'] ?? []);
    $pub = pv_block($c, 'published');
    $dr = pv_block($c, 'draft');
    $primary = $pub ?? $dr;
    $locs = [];
    pv_collect_locales([$pub, $dr], $locs);
    $locales = array_keys($locs);
    sort($locales, SORT_STRING);
    $title = $c['title'] ?? null;
    return [
        'id' => $v['id'], 'label' => $v['label'], 'note' => $v['note'], 'origin' => $v['origin'],
        'createdAt' => $v['createdAt'], 'updatedAt' => $v['updatedAt'], 'exportedAt' => $v['exportedAt'],
        'source' => $v['source'], 'platform' => $v['platform'],
        'widgets' => $primary === null ? 0 : pv_widget_count($primary),
        'bytes' => pv_content_bytes($c),
        'locales' => array_values(array_map('strval', $locales)),
        'hasPublished' => $pub !== null, 'hasDraft' => $dr !== null,
        'title' => lumen_json_is_object($title) ? $title : new stdClass(),
        'isActive' => $active !== null && $v['id'] === $active,
    ];
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** A stored version reduced to the shape the code relies on; null when it cannot be one. */
function pv_clean_version($v): ?array {
    if (!lumen_json_is_object($v) || !is_array($v)) return null;
    $id = $v['id'] ?? null;
    $content = $v['content'] ?? null;
    if (!pv_id_ok($id) || !lumen_json_is_object($content) || !in_array($v['origin'] ?? null, PV_ORIGINS, true)) return null;
    $str = function ($k) use ($v): string { return is_string($v[$k] ?? null) ? $v[$k] : ''; };
    $origin = (string)$v['origin'];
    return [
        'id' => $id,
        'label' => $str('label') !== '' ? $str('label') : 'Version',
        'note' => $str('note'),
        'origin' => $origin,
        'createdAt' => $str('createdAt'),
        'updatedAt' => $str('updatedAt') !== '' ? $str('updatedAt') : $str('createdAt'),
        'exportedAt' => $str('exportedAt'),
        'source' => $str('source'),
        'platform' => $str('platform'),
        'content' => $content,
    ];
}

/**
 * The history of a page. state: 'absent' (no file), 'ok', 'foreign' (a JSON object of another
 * schema: a newer platform wrote it — never touched) or 'corrupt' (anything else that is not a
 * readable history of this slug: not an object, a foreign slug, a damaged or repeated version).
 * @return array{state:string, active:?string, versions:array}
 */
function pv_load(string $slug): array {
    $empty = ['state' => 'absent', 'active' => null, 'versions' => []];
    $p = pv_path($slug);
    if ($p === null || !is_file($p)) return $empty;
    $size = @filesize($p);
    $raw = ($size !== false && $size <= PV_MAX_BYTES * 2) ? @file_get_contents($p) : false;
    $d = is_string($raw) ? lumen_json_decode_doc($raw) : null;
    if (!lumen_json_is_object($d) || !is_array($d)) { $empty['state'] = 'corrupt'; return $empty; }
    if (($d['schema'] ?? null) !== PV_SCHEMA) { $empty['state'] = 'foreign'; return $empty; }
    $list = $d['versions'] ?? null;
    if (($d['slug'] ?? null) !== $slug || !lumen_json_is_list($list) || count($list) > PV_MAX_VERSIONS) { $empty['state'] = 'corrupt'; return $empty; }
    $versions = [];
    $seen = [];
    foreach ($list as $raw1) {
        $v = pv_clean_version($raw1);
        if ($v === null || isset($seen[$v['id']])) { $empty['state'] = 'corrupt'; return $empty; }
        $seen[$v['id']] = true;
        $versions[] = $v;
    }
    $active = $d['active'] ?? null;
    return ['state' => 'ok', 'active' => (is_string($active) && isset($seen[$active])) ? $active : null, 'versions' => $versions];
}

/** The history for a read-modify-write: a corrupt file is parked aside as <slug>.corrupt-<stamp>.json (kept, never silently lost, still denied as *.json); a foreign one refuses. */
function pv_load_for_write(string $slug): array {
    $h = pv_load($slug);
    if ($h['state'] === 'foreign') return [null, pv_err(500, 'write_failed')];
    if ($h['state'] === 'corrupt') {
        $p = (string)pv_path($slug);
        if (!@rename($p, substr($p, 0, -5) . '.corrupt-' . gmdate('YmdHis') . '-' . bin2hex(random_bytes(2)) . '.json')) return [null, pv_err(500, 'write_failed')];
        $h['state'] = 'absent';
    }
    return [$h, null];
}

/** Write the history (or remove its file when no version is left). null on success, else the [status, payload] to answer. */
function pv_persist(string $slug, array $h): ?array {
    $p = pv_path($slug);
    if ($p === null) return pv_err(400, 'invalid_slug');
    if (!$h['versions']) {
        if (is_file($p) && !@unlink($p)) return pv_err(500, 'write_failed');
        return null;
    }
    $doc = ['schema' => PV_SCHEMA, 'slug' => $slug, 'active' => $h['active'], 'versions' => array_values($h['versions'])];
    $json = site_doc_json($doc);
    if (!is_string($json)) return pv_err(500, 'write_failed');
    if (strlen($json) > PV_MAX_BYTES) return pv_err(413, 'version_too_large');
    return lumen_write_file_atomic($p, $json, 0600) ? null : pv_err(500, 'write_failed');
}

function pv_find(array $h, string $id): ?int {
    foreach ($h['versions'] as $i => $v) if ($v['id'] === $id) return $i;
    return null;
}

function pv_new_id(array $h): string {
    do {
        $id = 'v' . bin2hex(random_bytes(6));
    } while (pv_find($h, $id) !== null);
    return $id;
}

/** Slugs that have a history file, sorted. */
function pv_all_slugs(): array {
    $out = [];
    foreach (@scandir(pv_dir()) ?: [] as $f) {
        if (substr($f, -5) !== '.json') continue;
        $slug = substr($f, 0, -5);
        if (pv_slug_ok($slug) && is_file(pv_dir() . '/' . $f)) $out[] = $slug;
    }
    sort($out, SORT_STRING);
    return array_slice($out, 0, 1000);
}

/** Run $fn under the history lock of $slug, inside the site doc lock when $withSite (site lock first, always). */
function pv_locked(string $slug, bool $withSite, callable $fn) {
    $run = function () use ($slug, $fn) { return lumen_with_lock((string)pv_path($slug), $fn); };
    return $withSite ? site_locked('pages/' . $slug, $run) : $run();
}

// ── Actions ──────────────────────────────────────────────────────────────────

function pv_version_record(string $id, string $label, string $note, string $origin, array $info, array $content): array {
    $now = pv_now();
    return [
        'id' => $id, 'label' => $label !== '' ? $label : 'Version', 'note' => $note, 'origin' => $origin,
        'createdAt' => $now, 'updatedAt' => $now,
        'exportedAt' => $info['exportedAt'], 'source' => $info['source'], 'platform' => $info['platform'],
        'content' => $content,
    ];
}

function pv_action_list(?string $slug): array {
    $pages = new stdClass();
    foreach ($slug !== null ? [$slug] : pv_all_slugs() as $s) {
        $h = pv_load($s);
        if (!$h['versions']) continue;
        $metas = [];
        foreach (array_reverse($h['versions']) as $v) $metas[] = pv_meta($v, $h['active']);
        $pages->{$s} = ['active' => $h['active'], 'count' => count($metas), 'versions' => $metas];
    }
    return [200, ['schema' => PV_SCHEMA, 'limits' => ['maxVersions' => PV_MAX_VERSIONS, 'maxBytes' => PV_MAX_BYTES], 'pages' => $pages]];
}

function pv_action_get(string $slug, string $id): array {
    $h = pv_load($slug);
    $i = pv_find($h, $id);
    if ($i === null) return pv_err(404, 'not_found');
    $v = $h['versions'][$i];
    return [200, ['ok' => true, 'version' => pv_meta($v, $h['active']) + ['content' => $v['content']]]];
}

/**
 * Make version $id the page's live state, the way an editor publish would. $h is the history
 * (read under the history lock, updated in place and persisted here); the caller holds the site
 * doc lock and the history lock. Steps: safety snapshot of a live state no stored version
 * captures → write the live doc → move the active marker. The history is written BEFORE the
 * live doc is touched, so what the activation replaces is never only in memory, and every limit
 * is checked before that first write. $dirty: $h carries a change to store anyway (a version
 * just added, $added), so an activation that cannot happen stores nothing of it.
 * @return array{0:int,1:array}
 */
function pv_activate_core(string $slug, array &$h, string $id, string $mode, string $snapshotLabel, bool $dirty = false, bool $added = false): array {
    $i = pv_find($h, $id);
    if ($i === null) return pv_err(404, 'not_found');
    $doc = 'pages/' . $slug;
    $vc = site_as_array($h['versions'][$i]['content']);

    $live = site_load_admin($doc);
    $live = is_array($live) ? $live : [];
    $stored = false;
    $fail = function (array $e) use (&$stored, $added, $id): array {
        if ($added && $stored) $e[1] += ['added' => true, 'id' => $id];
        return $e;
    };

    $snapshotId = null;
    $liveContent = pv_live_content($live);
    if ($liveContent !== null) {
        // Activating a version that carries a title replaces a different live title: it then survives only in a
        // stored version that holds it, so titles are compared too. A title-less version leaves the live title alone.
        $lt = pv_title_value($liveContent['title'] ?? null);
        $vt = pv_title_value($vc['title'] ?? null);
        $strict = $lt !== null && $vt !== null && pv_canon_json($lt) !== pv_canon_json($vt);
        $sig = pv_signature($liveContent, $strict);
        $known = false;
        foreach ($h['versions'] as $v) {
            if (pv_signature(site_as_array($v['content']), $strict) === $sig) { $known = true; break; }
        }
        if (!$known) {
            if (count($h['versions']) >= PV_MAX_VERSIONS) return pv_err(409, 'too_many_versions');
            $snap = pv_version_record(pv_new_id($h), $snapshotLabel, '', 'auto',
                ['exportedAt' => '', 'source' => '', 'platform' => ''], $liveContent);
            $h['versions'][] = $snap;
            $snapshotId = $snap['id'];
            $dirty = true;
        }
    }

    $pubV = pv_block($vc, 'published');
    $drV = pv_block($vc, 'draft');
    $titleV = pv_title_value($vc['title'] ?? null);
    $data = $live;
    if ($mode === 'publish') {
        $data['published'] = $pubV ?? $drV;
        $data['draft'] = $drV ?? $pubV;
    } else {
        $data['draft'] = $drV ?? $pubV;
        if (!lumen_json_is_object($data['published'] ?? null)) $data['published'] = ['sections' => []];
    }
    if ($titleV !== null) $data['title'] = $titleV;
    $data['schemaVersion'] = 2;
    // Each block alone passes the page-doc gate (the whole-doc gate would cap published + draft together at 2 MiB).
    $written = $mode === 'publish' ? ['published', 'draft'] : ['draft'];
    foreach ($written as $k) {
        if (!isset($data[$k])) return pv_err(400, 'invalid_content', ['detail' => 'the version holds no block to activate']);
        $err = pv_check_block($data[$k], $k);
        if ($err !== null) return pv_content_err($err);
    }

    if ($dirty) {
        $e = pv_persist($slug, $h);
        if ($e !== null) return $e;
        $stored = true;
    }

    $changed = ($live['schemaVersion'] ?? null) !== 2;
    foreach (['title', 'published', 'draft'] as $k) {
        if (array_key_exists($k, $data) !== array_key_exists($k, $live)
            || (array_key_exists($k, $data) && pv_canon_json($data[$k]) !== pv_canon_json($live[$k]))) { $changed = true; break; }
    }
    if ($changed && !site_save_doc($doc, $data)) return $fail(pv_err(500, 'write_failed'));

    if ($mode === 'publish' && $h['active'] !== $id) {
        $before = $h['active'];
        $h['active'] = $id;
        $e = pv_persist($slug, $h);
        if ($e !== null) { $h['active'] = $before; return $fail($e); }
    }
    $out = ['ok' => true, 'rev' => (string)site_rev($doc)];
    if ($snapshotId !== null) $out['snapshotId'] = $snapshotId;
    $out['active'] = $h['active'];
    return [200, $out];
}

/** Info strings shared by add / snapshots: [info, null] or [null, error]. */
function pv_info_fields(array $b): array {
    $info = [];
    foreach (['exportedAt', 'source', 'platform'] as $k) {
        $s = pv_field($b, $k, 64, 'info');
        if ($s === false) return [null, pv_err(400, 'invalid_body')];
        $info[$k] = $s ?? '';
    }
    return [$info, null];
}

function pv_action_add(string $slug, $body): array {
    if (!lumen_json_is_object($body)) return pv_err(400, 'invalid_body');
    $b = site_as_array($body);
    $origin = $b['origin'] ?? null;
    if (!is_string($origin) || !in_array($origin, PV_ORIGINS, true)) return pv_err(400, 'invalid_origin');
    $label = pv_field($b, 'label', 120);
    $note = pv_field($b, 'note', 2000, 'note');
    $snapLabel = pv_field($b, 'snapshotLabel', 120);
    if ($label === false || $note === false || $snapLabel === false) return pv_err(400, 'invalid_body');
    [$info, $e] = pv_info_fields($b);
    if ($e !== null) return $e;
    $mode = $b['activate'] ?? null;
    if ($mode !== null && (!is_string($mode) || !in_array($mode, ['publish', 'draft'], true))) return pv_err(400, 'invalid_mode');
    [$content, $detail] = pv_normalize_content($b['content'] ?? null);
    if ($content === null) return pv_content_err($detail);
    if (pv_content_bytes($content) > PV_MAX_CONTENT) return pv_err(413, 'version_too_large');

    return pv_locked($slug, $mode !== null, function () use ($slug, $label, $note, $snapLabel, $origin, $info, $content, $mode) {
        [$h, $e] = pv_load_for_write($slug);
        if ($h === null) return $e;
        if (count($h['versions']) >= PV_MAX_VERSIONS) return pv_err(409, 'too_many_versions');
        $id = pv_new_id($h);
        $h['versions'][] = pv_version_record($id, (string)$label, (string)$note, $origin, $info, $content);
        $snapshotId = null;
        if ($mode === null) {
            $e = pv_persist($slug, $h);
            if ($e !== null) return $e;
        } else {
            [$st, $out] = pv_activate_core($slug, $h, $id, $mode, ($snapLabel ?? '') !== '' ? (string)$snapLabel : 'Before activation', true, true);
            if ($st !== 200) return [$st, $out];
            $snapshotId = $out['snapshotId'] ?? null;
        }
        $i = pv_find($h, $id);
        $res = ['ok' => true, 'id' => $id, 'version' => pv_meta($h['versions'][(int)$i], $h['active'])];
        if ($snapshotId !== null) $res['snapshotId'] = $snapshotId;
        return [200, $res];
    });
}

function pv_action_update(string $slug, string $id, $body): array {
    if (!lumen_json_is_object($body)) return pv_err(400, 'invalid_body');
    $b = site_as_array($body);
    $label = pv_field($b, 'label', 120);
    $note = pv_field($b, 'note', 2000, 'note');
    if ($label === false || $note === false) return pv_err(400, 'invalid_body');
    $fromLive = $b['fromLive'] ?? null;
    if ($fromLive !== null && !is_bool($fromLive)) return pv_err(400, 'invalid_body');
    $hasContent = array_key_exists('content', $b) && $b['content'] !== null;
    if ($fromLive === true && $hasContent) return pv_err(400, 'invalid_body');
    if ($label === null && $note === null && !$hasContent && $fromLive !== true) return pv_err(400, 'nothing_to_update');
    $content = null;
    if ($hasContent) {
        [$content, $detail] = pv_normalize_content($b['content']);
        if ($content === null) return pv_content_err($detail);
        if (pv_content_bytes($content) > PV_MAX_CONTENT) return pv_err(413, 'version_too_large');
    }
    return pv_locked($slug, $fromLive === true, function () use ($slug, $id, $label, $note, $content, $fromLive) {
        [$h, $e] = pv_load_for_write($slug);
        if ($h === null) return $e;
        $i = pv_find($h, $id);
        if ($i === null) return pv_err(404, 'not_found');
        $v = $h['versions'][$i];
        if ($fromLive === true) {
            $live = site_load_admin('pages/' . $slug);
            $lc = pv_live_content(is_array($live) ? $live : []);
            if ($lc === null) return pv_err(400, 'invalid_content', ['detail' => 'the page has no live content']);
            $nav = site_as_array($v['content'])['nav'] ?? null;
            $content = [];
            if (isset($lc['title'])) $content['title'] = $lc['title'];
            if ($nav !== null) $content['nav'] = $nav;
            foreach (['published', 'draft'] as $k) if (isset($lc[$k])) $content[$k] = $lc[$k];
            if (pv_content_bytes($content) > PV_MAX_CONTENT) return pv_err(413, 'version_too_large');
        }
        if ($label !== null) $v['label'] = $label !== '' ? $label : 'Version';
        if ($note !== null) $v['note'] = $note;
        if ($content !== null) $v['content'] = $content;
        $v['updatedAt'] = pv_now();
        $h['versions'][$i] = $v;
        $e = pv_persist($slug, $h);
        if ($e !== null) return $e;
        return [200, ['ok' => true, 'version' => pv_meta($v, $h['active'])]];
    });
}

function pv_action_activate(string $slug, string $id, $body): array {
    $mode = 'publish';
    $snapLabel = '';
    if ($body !== null) {
        if (!lumen_json_is_object($body) && $body !== []) return pv_err(400, 'invalid_body');
        $b = site_as_array($body);
        $m = $b['mode'] ?? null;
        if ($m !== null) {
            if (!is_string($m) || !in_array($m, ['publish', 'draft'], true)) return pv_err(400, 'invalid_mode');
            $mode = $m;
        }
        $s = pv_field($b, 'snapshotLabel', 120);
        if ($s === false) return pv_err(400, 'invalid_body');
        $snapLabel = (string)$s;
    }
    return pv_locked($slug, true, function () use ($slug, $id, $mode, $snapLabel) {
        [$h, $e] = pv_load_for_write($slug);
        if ($h === null) return $e;
        return pv_activate_core($slug, $h, $id, $mode, $snapLabel !== '' ? $snapLabel : 'Before activation');
    });
}

function pv_action_delete(string $slug, string $id): array {
    return pv_locked($slug, false, function () use ($slug, $id) {
        [$h, $e] = pv_load_for_write($slug);
        if ($h === null) return $e;
        $i = pv_find($h, $id);
        if ($i === null) return pv_err(404, 'not_found');
        if ($h['active'] === $id) return pv_err(409, 'active_version');
        array_splice($h['versions'], $i, 1);
        $e = pv_persist($slug, $h);
        if ($e !== null) return $e;
        return [200, ['ok' => true, 'active' => $h['active']]];
    });
}

function pv_action_purge(string $slug): array {
    return pv_locked($slug, false, function () use ($slug) {
        $p = (string)pv_path($slug);
        if (is_file($p) && !@unlink($p)) return pv_err(500, 'write_failed');
        return [200, ['ok' => true]];
    });
}

/**
 * One request, after authentication and (for a write) CSRF: [status, payload]. $slug / $id are the raw
 * query values (null when absent or not a string), $body the request body as lumen_json_decode_doc gave it
 * (null when it was empty or not JSON).
 * @return array{0:int,1:array}
 */
function pv_handle(string $action, $slug, $id, $body): array {
    $reads = ['list', 'get'];
    $writes = ['add', 'update', 'activate', 'delete', 'purge'];
    if (!in_array($action, $reads, true) && !in_array($action, $writes, true)) return pv_err(400, 'Unknown action');
    if ($action === 'list') {
        if ($slug === '') $slug = null;   // a blank value is no filter, as the Python server's query parser sees it
        if ($slug !== null && !pv_slug_ok($slug)) return pv_err(400, 'invalid_slug');
        return pv_action_list($slug);
    }
    if (!pv_slug_ok($slug)) return pv_err(400, 'invalid_slug');
    if ($action === 'purge') return pv_action_purge($slug);
    if ($action === 'add') return pv_action_add($slug, $body);
    if (!pv_id_ok($id)) return pv_err(400, 'invalid_id');
    switch ($action) {
        case 'get':      return pv_action_get($slug, $id);
        case 'update':   return pv_action_update($slug, $id, $body);
        case 'activate': return pv_action_activate($slug, $id, $body);
        case 'delete':   return pv_action_delete($slug, $id);
    }
    return pv_err(400, 'Unknown action');
}
