<?php
/**
 * Lumen3D — Site configuration API (white-label). PHP twin of the
 * dev_server.py /api/site.php handler. PHP is the PRIMARY deployment target,
 * so this endpoint is a first-class implementation, not a fallback.
 *
 *   GET  ?action=get&doc=<instance|theme|legal|pages/<slug>>   (PUBLIC read)
 *   POST ?action=save&doc=...   body = JSON document            (admin + CSRF)
 *   POST ?action=reset&doc=...                                  (admin + CSRF)
 *   POST ?action=publish&doc=pages/<slug>                       (admin + CSRF)
 *
 * The docs live under the PUBLIC config/ dir (served like lang/*.json) so the
 * public pages can fetch them; they are written world-readable (0644), NOT
 * 0600 like api/ secrets, so a separate static server can serve them.
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';
admin_session_start();

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = $method === 'POST'
    ? (json_decode(file_get_contents('php://input'), true) ?: [])
    : [];

function site_config_dir(): string { return admin_root() . '/config'; }
function site_defaults_dir(): string { return admin_root() . '/config/defaults/neutral'; }

/** Map a doc name to [active, default] paths under config/, or null if unsafe. */
function site_doc_path(string $doc): ?array {
    $doc = trim($doc);
    if (in_array($doc, ['instance', 'theme', 'legal'], true)) {
        return [site_config_dir() . "/$doc.json", site_defaults_dir() . "/$doc.json"];
    }
    if (strncmp($doc, 'pages/', 6) === 0) {
        $slug = substr($doc, 6);
        if (preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $slug)) {
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
    if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/', $slug)) return null;
    return __DIR__ . '/page-drafts/' . $slug . '.json';
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
    $dir = dirname($path);
    if (!is_dir($dir)) admin_make_dir($dir);
    $tmp = tempnam($dir, '.tmp-');
    if ($tmp === false) return false;
    if (@file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)) === false) {
        @unlink($tmp); return false;
    }
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    @chmod($path, 0600);
    return true;
}

/** Atomic write of a PUBLIC config doc (0644, not 0600). */
function site_write_public(string $path, array $data): bool {
    $dir = dirname($path);
    if (!is_dir($dir)) admin_make_dir($dir);
    $tmp = tempnam($dir, '.tmp-');
    if ($tmp === false) return false;
    if (@file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)) === false) {
        @unlink($tmp); return false;
    }
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    admin_fix_file_mode($path);
    return true;
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
        $css = site_generate_theme_css($data);
        $cssPath = site_config_dir() . '/theme.css';
        $tmp = tempnam(dirname($cssPath), '.tmp-');
        if ($tmp !== false && @file_put_contents($tmp, $css) !== false && @rename($tmp, $cssPath)) {
            admin_fix_file_mode($cssPath);
        } elseif ($tmp !== false) { @unlink($tmp); }
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

// ── Public read ───────────────────────────────────────────────────────────────
// Only the operator gets the draft back; everyone else sees published content.
if ($action === 'get') {
    $doc  = $_GET['doc'] ?? '';
    $data = admin_is_auth() ? site_load_admin($doc) : site_load_public($doc);
    if ($data === false) admin_json_out(['error' => 'Invalid doc'], 400);
    admin_json_out(is_array($data) ? $data : []);
}

// ── Writes: admin session + CSRF ──────────────────────────────────────────────
if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);

if (in_array($action, ['save', 'reset', 'publish', 'delete'], true)) {
    admin_require_write();  // POST + CSRF; exits on failure
    $doc = $_GET['doc'] ?? '';
    if ($action === 'save') {
        $payload = is_array($body) ? $body : [];
        if (strncmp($doc, 'pages/', 6) === 0) {
            $verr = site_validate_page($payload);
            if ($verr !== null) admin_json_out(['error' => $verr], 400);
        }
        admin_json_out(site_save_doc($doc, $payload) ? ['ok' => true] : ['error' => 'Invalid doc'], site_doc_path($doc) === null ? 400 : 200);
    }
    if ($action === 'reset')   admin_json_out(site_reset_doc($doc) ? ['ok' => true] : ['error' => 'Invalid doc'], site_doc_path($doc) === null ? 400 : 200);
    if ($action === 'publish') admin_json_out(site_publish_doc($doc) ? ['ok' => true] : ['error' => 'Invalid doc'], site_doc_path($doc) === null ? 400 : 200);
    if ($action === 'delete')  admin_json_out(site_delete_doc($doc) ? ['ok' => true] : ['error' => 'Invalid doc'], site_doc_path($doc) === null ? 400 : 200);
}

admin_json_out(['error' => 'Unknown action'], 400);
