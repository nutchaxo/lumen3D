<?php
/**
 * Lumen3D — Page version history API. PHP twin of the dev_server.py /api/page-versions.php
 * handler; the rules (storage, limits, activation) live in _page_versions_lib.php and in
 * DOCS/pages-library/SPEC.md §2–§3.
 *
 *   GET  ?action=list[&slug=S]                      every page that has a history (or just S)
 *   GET  ?action=get&slug=S&id=V                    one version, content included
 *   POST ?action=add&slug=S                         body {label?, note?, origin, content, activate?, …}
 *   POST ?action=update&slug=S&id=V                 body {label?, note?, content? | fromLive?}
 *   POST ?action=activate&slug=S&id=V               body {mode?: publish|draft, snapshotLabel?}
 *   POST ?action=delete&slug=S&id=V                 the active version is refused (409)
 *   POST ?action=purge&slug=S                       drop the whole history of a page
 *
 * Everything needs the admin session (anonymous → 401); every write is POST + CSRF.
 * LUMEN_PV_LIB (tests) = helpers only, nothing routed.
 */

declare(strict_types=1);
// Guarded: an update copies files one by one, and a request landing mid-copy must not die on a missing prelude.
if (is_file(__DIR__ . '/_bootstrap.php')) require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/_page_versions_lib.php';

if (defined('LUMEN_PV_LIB')) return;

admin_session_resume();
// Read-only use of the session from here on (auth, CSRF): release its lock so this request
// never serialises with the rest of the admin (see api/admin.php).
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);

$action = lumen_str($_GET['action'] ?? null) ?? '';
$slug = lumen_str($_GET['slug'] ?? null);
$id = lumen_str($_GET['id'] ?? null);

if (!in_array($action, ['list', 'get', 'add', 'update', 'activate', 'delete', 'purge'], true)) {
    admin_json_out(['error' => 'Unknown action'], 400);
}

$body = null;
if (in_array($action, ['add', 'update', 'activate', 'delete', 'purge'], true)) {
    admin_require_write();   // POST + CSRF; exits on failure
    $raw = (string)file_get_contents('php://input');
    if (strlen($raw) > PV_MAX_BODY) admin_json_out(['error' => 'version_too_large'], 413);
    if (trim($raw) !== '') {
        $body = lumen_json_decode_doc($raw);
        // Anything that is not JSON is a malformed request, whatever the action (a literal `null` is "no body").
        if ($body === null && trim($raw) !== 'null') admin_json_out(['error' => 'invalid_body'], 400);
    }
}

[$status, $out] = pv_handle($action, $slug, $id, $body);
admin_json_out($out, $status);
