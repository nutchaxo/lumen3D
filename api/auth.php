<?php
/**
 * IRIBHM Microscopy Platform — Admin Authentication (PHP fallback)
 * ================================================================
 * Mirrors dev_server.py's auth routes. The admin password lives ONLY in the
 * dedicated credential store (api/admin_credential.json) as a one-way PBKDF2 hash
 * — never in plaintext, never served (see api/.htaccess). First-run setup is
 * create-exclusive so it can never overwrite a live credential.
 *
 * Endpoints:
 *   GET  ?action=status           → {authenticated, username, csrf, needsSetup}
 *   POST ?action=login            {username,password} → {ok, csrf} | {error}
 *   POST ?action=logout           → {ok}
 *   POST ?action=setup            {username,password} → {ok, username, csrf} (only if no credential)
 *   POST ?action=change_password  {current,new} → {ok} (auth + CSRF + current pw)
 *
 * Login throttling, the client address behind a declared proxy, the session rules
 * (strict ids, absolute 8 h expiry, sign-out of other sessions on a password change)
 * and the same-origin check for the token-less login/logout live in _admin_lib.php.
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

admin_update_finish_pending();   // no-op unless a prior update parked busy files
header('X-Content-Type-Options: nosniff');
admin_session_start();

$action = lumen_str($_GET['action'] ?? null) ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = $method === 'POST' ? (lumen_request_json() ?? []) : [];

switch ($action) {

    case 'status':
        admin_json_out([
            'authenticated' => admin_is_auth(),
            'username'      => admin_is_auth() ? ($_SESSION['admin_user'] ?? null) : null,
            'csrf'          => admin_is_auth() ? admin_csrf() : null,
            'needsSetup'    => !admin_credential_exists(),
        ]);

    case 'login': {
        // POST-only: a credential must never travel in a URL (proxy/access logs,
        // Referer). JSON + same origin: another site must not be able to sign this
        // browser into an account of its choosing (login CSRF).
        if ($method !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
        if (!admin_same_origin_json()) admin_json_out(['error' => 'cross_origin_refused'], 403);
        $u = lumen_str($body['username'] ?? null);
        $p = lumen_str($body['password'] ?? null);
        if ($u === null || $p === null) admin_json_out(['error' => 'bad_request'], 400);
        $u = trim($u);
        // The attempt is counted BEFORE the hash runs (see admin_bf_reserve).
        admin_bf_gate();
        [$ok, $why] = admin_login_verify($u, $p);
        if (!$ok) {
            if ($why === 'credential_upgrade_failed') admin_json_out(['error' => $why], 500);
            admin_json_out(['error' => 'Identifiants incorrects.'], 401);
        }
        admin_bf_success();
        admin_session_login($u);
        admin_json_out(['ok' => true, 'username' => $u, 'csrf' => admin_csrf()]);
    }

    case 'logout':
        if ($method !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
        if (!admin_same_origin_json()) admin_json_out(['error' => 'cross_origin_refused'], 403);
        $_SESSION = [];
        session_destroy();
        admin_json_out(['ok' => true]);

    case 'setup':
        if ($method !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
        $u = lumen_str($body['username'] ?? 'admin');
        $p = lumen_str($body['password'] ?? '');
        if ($u === null || $p === null) admin_json_out(['error' => 'bad_request'], 400);
        admin_bf_gate();
        [$ok, $code, $payload] = admin_setup_credential($u, $p);
        if ($ok) {
            admin_bf_success();
            admin_session_login($payload['username']);
            $payload['csrf'] = admin_csrf();
            admin_json_out($payload);
        }
        admin_json_out($payload, $code);

    case 'change_password': {
        if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);
        admin_require_write();
        $cur = lumen_str($body['current'] ?? null);
        $new = lumen_str($body['new'] ?? null);
        if ($cur === null || $new === null) admin_json_out(['error' => 'bad_request'], 400);
        admin_bf_gate();
        [$ok, $code, $payload] = admin_change_credential($cur, $new);
        if ($code !== 401) admin_bf_success();       // only a wrong current password counts
        if ($ok) {
            // The new credential stamp signs every other session out; this one is
            // re-issued under a fresh id and the new stamp.
            admin_session_login((string)($_SESSION['admin_user'] ?? (admin_credential()['username'] ?? 'admin')), false);
            $payload['csrf'] = admin_csrf();
        }
        admin_json_out($payload, $code);
    }

    default:
        admin_json_out(['error' => 'Unknown action.'], 400);
}
