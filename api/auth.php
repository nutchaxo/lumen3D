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
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

header('X-Content-Type-Options: nosniff');
admin_session_start();

// ── Brute-force lockout (per server, file-based; mirrors the Python budget) ──
$LOCKOUT_FILE = sys_get_temp_dir() . '/iribhm_admin_lockout_' . md5(__DIR__) . '.json';
$MAX_ATTEMPTS = 10;
$LOCKOUT_SECS = 900;
function bf_load(): array { global $LOCKOUT_FILE; $d = @json_decode(@file_get_contents($LOCKOUT_FILE), true); return is_array($d) ? $d : ['attempts' => 0, 'until' => 0]; }
function bf_locked(): bool { $l = bf_load(); return ($l['until'] ?? 0) > time(); }
function bf_fail(): void { global $LOCKOUT_FILE, $MAX_ATTEMPTS, $LOCKOUT_SECS; $l = bf_load(); $l['attempts'] = ($l['attempts'] ?? 0) + 1; if ($l['attempts'] >= $MAX_ATTEMPTS) { $l['until'] = time() + $LOCKOUT_SECS; $l['attempts'] = 0; } @file_put_contents($LOCKOUT_FILE, json_encode($l)); }
function bf_clear(): void { global $LOCKOUT_FILE; @file_put_contents($LOCKOUT_FILE, json_encode(['attempts' => 0, 'until' => 0])); }

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = $method === 'POST' ? (json_decode(file_get_contents('php://input'), true) ?: []) : [];

switch ($action) {

    case 'status':
        admin_json_out([
            'authenticated' => admin_is_auth(),
            'username'      => $_SESSION['admin_user'] ?? null,
            'csrf'          => admin_is_auth() ? admin_csrf() : null,
            'needsSetup'    => !admin_credential_exists(),
        ]);

    case 'login':
        if (bf_locked()) admin_json_out(['error' => 'Trop de tentatives. Réessayez plus tard.'], 429);
        $u = trim($body['username'] ?? '');
        $p = $body['password'] ?? '';
        if (!admin_check_credentials($u, $p)) { bf_fail(); admin_json_out(['error' => 'Identifiants incorrects.'], 401); }
        bf_clear();
        session_regenerate_id(true);
        $_SESSION['admin_authenticated'] = true;
        $_SESSION['admin_user'] = $u;
        admin_json_out(['ok' => true, 'username' => $u, 'csrf' => admin_csrf()]);

    case 'logout':
        $_SESSION = [];
        session_destroy();
        admin_json_out(['ok' => true]);

    case 'setup':
        if ($method !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
        if (bf_locked()) admin_json_out(['error' => 'Trop de tentatives. Réessayez plus tard.'], 429);
        $u = $body['username'] ?? 'admin';
        $p = $body['password'] ?? '';
        [$ok, $code, $payload] = admin_setup_credential($u, $p);
        if ($ok) {
            session_regenerate_id(true);
            $_SESSION['admin_authenticated'] = true;
            $_SESSION['admin_user'] = $payload['username'];
            $payload['csrf'] = admin_csrf();
            admin_json_out($payload);
        }
        bf_fail();
        admin_json_out($payload, $code);

    case 'change_password':
        if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);
        admin_require_write();
        [$ok, $code, $payload] = admin_change_credential($body['current'] ?? '', $body['new'] ?? '');
        admin_json_out($payload, $code);

    default:
        admin_json_out(['error' => 'Unknown action.'], 400);
}
