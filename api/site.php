<?php
/**
 * Lumen3D — Site configuration API (white-label). PHP twin of the
 * dev_server.py /api/site.php handler. PHP is the PRIMARY deployment target,
 * so this endpoint is a first-class implementation, not a fallback.
 *
 *   GET  ?action=get&doc=<instance|theme|legal>   (public read; a page: admin only)
 *   GET  ?action=get&doc=pages/<slug>             (admin; anonymous → 401 — the public
 *                                                   pages read config/pages/<slug>.json)
 *   POST ?action=save&doc=...[&rev=R][&merge=a,b.c]   body = JSON document (admin + CSRF)
 *   POST ?action=save_draft&doc=pages/<slug>[&rev=R]  body = {draft, title?}  (admin + CSRF)
 *   POST ?action=reset&doc=...                                  (admin + CSRF)
 *   POST ?action=publish&doc=pages/<slug>                       (admin + CSRF)
 *
 * Revisions: an admin GET answers with `X-Lumen-Rev`, every write with {rev}. A write
 * sent with ?rev= of a revision that is no longer current is refused with 409
 * {error:'stale', rev}. `merge` replaces only the listed (dotted) paths of the stored
 * document, so tabs that share instance.json never overwrite each other's fields.
 * Twin of dev_server.py's /api/site.php handler (_site_rev, _merge_paths,
 * _site_save_draft).
 *
 * The docs live under the PUBLIC config/ dir (served like lang/*.json) so the
 * public pages can fetch them; they are written world-readable (0644), NOT
 * 0600 like api/ secrets, so a separate static server can serve them.
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

// Library mode (tests): the helpers below are defined, nothing is routed and no
// session is touched. LUMEN_CONFIG_DIR / LUMEN_PAGE_DRAFTS_DIR point them elsewhere.
function site_config_dir(): string { return defined('LUMEN_CONFIG_DIR') ? (string)LUMEN_CONFIG_DIR : admin_root() . '/config'; }
function site_defaults_dir(): string { return site_config_dir() . '/defaults/neutral'; }
function site_drafts_dir(): string { return defined('LUMEN_PAGE_DRAFTS_DIR') ? (string)LUMEN_PAGE_DRAFTS_DIR : __DIR__ . '/page-drafts'; }

/** Map a doc name to [active, default] paths under config/, or null if unsafe. */
function site_doc_path(string $doc): ?array {
    $doc = trim($doc);
    if (in_array($doc, ['instance', 'theme', 'legal'], true)) {
        return [site_config_dir() . "/$doc.json", site_defaults_dir() . "/$doc.json"];
    }
    if (strncmp($doc, 'pages/', 6) === 0) {
        $slug = substr($doc, 6);
        if (preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/D', $slug)) {
            return [site_config_dir() . "/pages/$slug.json", site_defaults_dir() . "/pages/$slug.json"];
        }
    }
    return null;
}

/** Where a page's UNPUBLISHED draft lives — deliberately OUTSIDE the public config/
 *  tree. config/pages/<slug>.json is served statically to every visitor, so a draft
 *  block stored inline was world-readable: the editor autosaves roughly every second,
 *  so polling that URL let anyone watch the operator write. api/ is denied by
 *  api/.htaccess, router.php and the Python static filter alike. Null for docs that
 *  have no draft concept (instance/theme/legal) or an unsafe slug. */
function site_draft_path(string $doc): ?string {
    $doc = trim($doc);
    if (strncmp($doc, 'pages/', 6) !== 0) return null;
    $slug = substr($doc, 6);
    if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/D', $slug)) return null;
    return site_drafts_dir() . '/' . $slug . '.json';
}

/** Read a doc: active → default → empty. false on invalid doc name.
 *  The result may still carry a legacy inline `draft` (pre-split documents); use
 *  site_load_public() or site_load_admin() rather than calling this directly. */
function site_load_doc(string $doc) {
    $res = site_doc_path($doc);
    if ($res === null) return false;
    foreach ($res as $p) {
        if (is_file($p)) {
            $d = json_decode((string)@file_get_contents($p), true);
            if (is_array($d)) return $d;
        }
    }
    return [];
}

/** The doc as any visitor may see it: published content only, never the draft. */
function site_load_public(string $doc) {
    $data = site_load_doc($doc);
    if ($data === false) return false;
    unset($data['draft']);
    return $data;
}

/** The doc as the operator sees it: published content + the private draft. */
function site_load_admin(string $doc) {
    $data = site_load_doc($doc);
    if ($data === false) return false;
    $draft = null;
    $p = site_draft_path($doc);
    if ($p !== null && is_file($p)) {
        $d = json_decode((string)@file_get_contents($p), true);
        if (is_array($d)) $draft = $d;
    }
    // Back-compat: documents written before the split kept the draft inline. Keep
    // serving it so no work is lost — the next save relocates it — but it must never
    // stay in a payload that could reach a non-admin.
    if ($draft === null && isset($data['draft']) && is_array($data['draft'])) $draft = $data['draft'];
    unset($data['draft']);
    if ($draft !== null) $data['draft'] = $draft;
    return $data;
}

/** Atomic write of a PRIVATE doc under api/ (0600, never web-readable). */
function site_write_private(string $path, array $data): bool {
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    return $json !== false && lumen_write_file_atomic($path, $json, 0600);
}

/** Atomic write of a PUBLIC config doc (readable by the web server, not 0600). */
function site_write_public(string $path, array $data): bool {
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    return $json !== false && lumen_write_file_atomic($path, $json);
}

/** Scrub a CSS value so operator input can never break out of a declaration. */
function site_scrub_css_value($v): string {
    $s = (string)$v;
    $s = str_replace(['{', '}', ';', '<', '>', '\\', '@', "\n", "\r"], ['', '', '', '', '', '', '', ' ', ' '], $s);
    return substr(trim($s), 0, 200);
}

function site_theme_block(string $selector, $tokens): string {
    if (!is_array($tokens)) return '';
    $decls = [];
    foreach ($tokens as $name => $val) {
        if (!is_string($name) || !preg_match('/^--[A-Za-z0-9-]+$/', $name)) continue;
        $sv = site_scrub_css_value($val);
        if ($sv !== '') $decls[] = "$name:$sv";
    }
    return $decls ? ($selector . '{' . implode(';', $decls) . "}\n") : '';
}

/** Compile config/theme.json → the override sheet. Twin of dev_server.py:_generate_theme_css. */
function site_generate_theme_css($theme): string {
    if (!is_array($theme)) $theme = [];
    $out = "/* GENERATED from config/theme.json by the theme editor — do not edit by hand. */\n";
    $out .= site_theme_block(':root', $theme['tokens'] ?? null);
    if (!empty($theme['dark']))  $out .= site_theme_block('[data-theme="dark"]', $theme['dark']);
    if (!empty($theme['light'])) $out .= site_theme_block('[data-theme="light"]', $theme['light']);
    return $out;
}

/** Structural gate for a page doc (twin of dev_server.py:_validate_page_doc).
 * Returns null on success, or an error string. Mutates $data (schemaVersion +
 * width clamp). Forward-compatible: unknown widget types are allowed. */
function site_validate_page(array &$data): ?string {
    $raw = json_encode($data);
    if ($raw === false) return 'Malformed page document';
    if (strlen($raw) > 2097152) return 'Page document too large';
    $data['schemaVersion'] = 2;
    foreach (['published', 'draft'] as $key) {
        if (!isset($data[$key])) continue;
        if (!is_array($data[$key])) return "Invalid '$key' block";
        if (!isset($data[$key]['sections'])) continue;
        $secs = $data[$key]['sections'];
        if (!is_array($secs) || count($secs) > 300) return 'Invalid sections';
        foreach ($data[$key]['sections'] as &$s) {
            if (!is_array($s)) return 'Invalid section';
            if (!isset($s['columns'])) continue;
            if (!is_array($s['columns']) || count($s['columns']) > 12) return 'Invalid columns';
            foreach ($s['columns'] as &$c) {
                if (!is_array($c)) return 'Invalid column';
                if (isset($c['width']) && is_numeric($c['width'])) $c['width'] = max(1, min(12, (int)$c['width']));
                if (!isset($c['widgets'])) continue;
                if (!is_array($c['widgets']) || count($c['widgets']) > 500) return 'Invalid widgets';
                foreach ($c['widgets'] as $wd) {
                    if (!is_array($wd) || !isset($wd['type']) || !is_string($wd['type'])) return 'Invalid widget';
                }
            }
            unset($c);
        }
        unset($s);
    }
    return null;
}

function site_save_doc(string $doc, $data): bool {
    $res = site_doc_path($doc);
    if ($res === null || !is_array($data)) return false;
    // Split the draft out before ANYTHING reaches the public config/ tree.
    $draftPath = site_draft_path($doc);
    if ($draftPath !== null) {
        $draft = (isset($data['draft']) && is_array($data['draft'])) ? $data['draft'] : null;
        unset($data['draft']);
        if ($draft === null) {
            if (is_file($draftPath)) @unlink($draftPath);
        } elseif (!site_write_private($draftPath, $draft)) {
            return false;   // never publish the public half if the draft could not be kept
        }
    }
    if (!site_write_public($res[0], $data)) return false;
    if ($doc === 'theme') {
        lumen_write_file_atomic(site_config_dir() . '/theme.css', site_generate_theme_css($data));
    }
    return true;
}

function site_reset_doc(string $doc): bool {
    $res = site_doc_path($doc);
    if ($res === null) return false;
    [$active, $default] = $res;
    $content = is_file($default) ? json_decode((string)@file_get_contents($default), true) : [];
    if (!is_array($content)) $content = [];
    // Route through save so theme.css regeneration fires on reset too.
    return site_save_doc($doc, $content);
}

/** Delete a custom page doc (config/pages/<slug>.json). Refuses instance/theme/
 * legal (those revert-to-default; never removed). Idempotent. */
function site_delete_doc(string $doc): bool {
    $doc = trim($doc);
    if (strncmp($doc, 'pages/', 6) !== 0) return false;
    $res = site_doc_path($doc);
    if ($res === null) return false;
    $active = $res[0];
    if (is_file($active) && !@unlink($active)) return false;
    // The private draft is part of the page: deleting the page must not orphan it.
    $draftPath = site_draft_path($doc);
    if ($draftPath !== null && is_file($draftPath)) @unlink($draftPath);
    return true;
}

function site_publish_doc(string $doc): bool {
    $data = site_load_admin($doc);   // needs the private draft to promote it
    if ($data === false) return false;
    if (is_array($data) && array_key_exists('draft', $data)) {
        $data['published'] = $data['draft'];
        return site_save_doc($doc, $data);
    }
    return true;
}

/** Revision of a doc as the operator sees it: sha256 over the stored public file and,
 *  for a page, its private draft (a missing file counts as empty), first 20 hex.
 *  Twin of dev_server.py _site_rev — same bytes, same revision. */
function site_rev(string $doc): ?string {
    $res = site_doc_path($doc);
    if ($res === null) return null;
    $ctx = hash_init('sha256');
    foreach ([$res[0], site_draft_path($doc)] as $path) {
        $data = ($path !== null && is_file($path)) ? @file_get_contents($path) : '';
        if (!is_string($data)) $data = '';
        hash_update($ctx, strlen($data) . ':' . $data . ';');
    }
    return substr(hash_final($ctx), 0, 20);
}

/** `merge=variables,editor,nav.customPages` → validated dotted paths, or null. */
function site_parse_merge($raw): ?array {
    $paths = array_values(array_filter(array_map('trim', explode(',', (string)$raw)), 'strlen'));
    if (!$paths || count($paths) > 32) return null;
    foreach ($paths as $p) {
        if (!preg_match('/^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,3}\z/', $p)) return null;
    }
    return $paths;
}

/** $current with each dotted path replaced by its value in $incoming — or removed when
 *  $incoming has none. Keys nobody listed are left untouched. Twin of _merge_paths. */
function site_merge_paths(array $current, array $incoming, array $paths): array {
    foreach ($paths as $path) {
        $segs = explode('.', $path);
        $src = $incoming; $found = true;
        foreach ($segs as $seg) {
            if (is_array($src) && array_key_exists($seg, $src)) { $src = $src[$seg]; }
            else { $found = false; break; }
        }
        $node = &$current;
        $ok = true;
        foreach (array_slice($segs, 0, -1) as $seg) {
            if (!isset($node[$seg]) || !is_array($node[$seg])) {
                if (!$found) { $ok = false; break; }
                $node[$seg] = [];
            }
            $node = &$node[$seg];
        }
        if ($ok) {
            $leaf = end($segs);
            if ($found) $node[$leaf] = $src; else unset($node[$leaf]);
        }
        unset($node);
    }
    return $current;
}

/** Run $fn under the site-doc lock (one per doc). */
function site_locked(string $doc, callable $fn) {
    $res = site_doc_path($doc);
    if ($res === null) return $fn();
    return lumen_with_lock($res[0], $fn);
}

/** Save with an optional stale-revision check and field merge. @return array{0:int,1:array} */
function site_save_checked(string $doc, $data, ?string $rev, ?array $merge): array {
    if (site_doc_path($doc) === null) return [400, ['error' => 'Invalid doc']];
    return site_locked($doc, function () use ($doc, $data, $rev, $merge) {
        $current = site_rev($doc);
        if ($rev !== null && $rev !== '' && $rev !== $current) return [409, ['error' => 'stale', 'rev' => $current]];
        if ($merge !== null) {
            if (strncmp(trim($doc), 'pages/', 6) === 0) return [400, ['error' => 'merge_not_supported']];
            $base = site_load_doc($doc);
            $data = site_merge_paths(is_array($base) ? $base : [], is_array($data) ? $data : [], $merge);
        }
        if (!site_save_doc($doc, is_array($data) ? $data : [])) return [400, ['error' => 'Invalid doc']];
        return [200, ['ok' => true, 'rev' => site_rev($doc)]];
    });
}

/** Write ONLY a page's private draft — and its title when the body carries one. The
 *  published block is never touched. Body {draft, title?}. Twin of _site_save_draft. */
function site_save_draft(string $doc, $body, ?string $rev): array {
    $doc = trim($doc);
    $draftPath = site_draft_path($doc);
    if ($draftPath === null) return [400, ['error' => 'Invalid doc']];
    $body = is_array($body) ? $body : [];
    $draft = $body['draft'] ?? null;
    if (!is_array($draft) || ($draft && array_keys($draft) === range(0, count($draft) - 1))) {
        return [400, ['error' => "Invalid 'draft' block"]];
    }
    $probe = ['draft' => $draft];
    $err = site_validate_page($probe);
    if ($err !== null) return [400, ['error' => $err]];
    return site_locked($doc, function () use ($doc, $body, $rev, $draftPath, $probe) {
        $current = site_rev($doc);
        if ($rev !== null && $rev !== '' && $rev !== $current) return [409, ['error' => 'stale', 'rev' => $current]];
        if (array_key_exists('title', $body)) {
            $public = site_load_public($doc);
            $public = is_array($public) ? $public : [];
            if (($public['title'] ?? null) !== $body['title']) {
                $public['title'] = $body['title'];
                if (!isset($public['published']) || !is_array($public['published'])) $public['published'] = ['sections' => []];
                $public['schemaVersion'] = 2;
                if (!site_write_public(site_doc_path($doc)[0], $public)) return [500, ['error' => 'write_failed']];
            }
        }
        if (!is_dir(dirname($draftPath)) && !admin_make_dir(dirname($draftPath))) return [500, ['error' => 'write_failed']];
        if (!site_write_private($draftPath, $probe['draft'])) return [500, ['error' => 'write_failed']];
        return [200, ['ok' => true, 'rev' => site_rev($doc)]];
    });
}

if (defined('LUMEN_SITE_LIB')) return;

// The public read is served to every visitor of a custom page: a session is only
// resumed when the client already carries one (the operator), never created — one
// session file and one Set-Cookie per anonymous visit was the old cost.
admin_session_resume();
// Read-only use of the session from here on (auth, CSRF): release its lock so this
// request never serialises with the rest of the admin (see api/admin.php).
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

$action = lumen_str($_GET['action'] ?? null) ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = $method === 'POST'
    ? (json_decode((string)file_get_contents('php://input'), true) ?: [])
    : [];

// ── Public read ───────────────────────────────────────────────────────────────
// Only the operator gets the draft back; everyone else sees published content.
if ($action === 'get') {
    $doc  = lumen_str($_GET['doc'] ?? null) ?? '';
    $auth = admin_is_auth();
    // An anonymous read of a PAGE is refused: the public pages read the static
    // published copy, and an admin whose session expired must learn it here rather
    // than be handed the published-only doc and autosave it over the draft.
    if (!$auth && strncmp(trim($doc), 'pages/', 6) === 0) admin_json_out(['error' => 'Not authenticated'], 401);
    $data = $auth ? site_load_admin($doc) : site_load_public($doc);
    if ($data === false) admin_json_out(['error' => 'Invalid doc'], 400);
    if ($auth) {
        header('Cache-Control: no-store');
        header('X-Lumen-Rev: ' . (site_rev($doc) ?? ''));
    }
    admin_json_out(is_array($data) ? $data : []);
}

// ── Writes: admin session + CSRF ──────────────────────────────────────────────
if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);

if (in_array($action, ['save', 'save_draft', 'reset', 'publish', 'delete'], true)) {
    admin_require_write();  // POST + CSRF; exits on failure
    $doc = lumen_str($_GET['doc'] ?? null) ?? '';
    $rev = lumen_str($_GET['rev'] ?? null);
    if ($action === 'save') {
        $payload = is_array($body) ? $body : [];
        $merge = null;
        if (isset($_GET['merge'])) {
            $merge = site_parse_merge(lumen_str($_GET['merge']) ?? '');
            if ($merge === null) admin_json_out(['error' => 'bad_merge'], 400);
        }
        if (strncmp($doc, 'pages/', 6) === 0) {
            $verr = site_validate_page($payload);
            if ($verr !== null) admin_json_out(['error' => $verr], 400);
        }
        [$code, $out] = site_save_checked($doc, $payload, $rev, $merge);
        admin_json_out($out, $code);
    }
    if ($action === 'save_draft') {
        [$code, $out] = site_save_draft($doc, $body, $rev);
        admin_json_out($out, $code);
    }
    if (site_doc_path($doc) === null) admin_json_out(['error' => 'Invalid doc'], 400);
    if ($action === 'reset') {
        $ok = site_locked($doc, fn() => site_reset_doc($doc));
        admin_json_out($ok ? ['ok' => true, 'rev' => site_rev($doc)] : ['error' => 'Invalid doc'], $ok ? 200 : 400);
    }
    if ($action === 'publish') {
        $ok = site_locked($doc, fn() => site_publish_doc($doc));
        admin_json_out($ok ? ['ok' => true, 'rev' => site_rev($doc)] : ['error' => 'Invalid doc'], $ok ? 200 : 400);
    }
    if ($action === 'delete') {
        $ok = site_locked($doc, fn() => site_delete_doc($doc));
        admin_json_out($ok ? ['ok' => true] : ['error' => 'Invalid doc'], $ok ? 200 : 400);
    }
}

admin_json_out(['error' => 'Unknown action'], 400);
