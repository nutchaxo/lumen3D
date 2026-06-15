<?php
/**
 * IRIBHM Microscopy Platform — Admin Authentication
 * ==================================================
 * Handles login/logout/status for the /admpan admin panel.
 *
 * Security model:
 *  - Credentials stored in config.php (never in DATA_WEB)
 *  - PHP sessions (HttpOnly, SameSite=Strict cookie)
 *  - Brute-force protection: 5 attempts → 15-minute lockout
 *  - CORS locked to same-origin
 *
 * Endpoints:
 *   POST ?action=login   {username, password} → {ok, error?}
 *   POST ?action=logout  → {ok}
 *   GET  ?action=status  → {authenticated}
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache');

// ── Config ───────────────────────────────────────────────────────────────────
$CONFIG_FILE = __DIR__ . '/config.php';

if (!file_exists($CONFIG_FILE)) {
    // First-run: create default config with a hashed password
    // Default credentials: admin / iribhm2024  (CHANGE ON FIRST LOGIN)
    $default = '<?php' . "\n" .
        '// Admin credentials — edit this file to change password' . "\n" .
        '$ADMIN_USERNAME = "admin";' . "\n" .
        '// To generate a new hash: php -r "echo password_hash(\'yourpassword\', PASSWORD_BCRYPT);"' . "\n" .
        '$ADMIN_PASSWORD_HASH = "' . password_hash('iribhm2024', PASSWORD_BCRYPT) . '";' . "\n" .
        '$ADMIN_SESSION_LIFETIME = 28800; // 8 hours' . "\n";
    file_put_contents($CONFIG_FILE, $default);
}
require_once $CONFIG_FILE;

// ── Session ──────────────────────────────────────────────────────────────────
$session_lifetime = $ADMIN_SESSION_LIFETIME ?? 28800;
session_set_cookie_params([
    'lifetime' => $session_lifetime,
    'path'     => '/',
    'secure'   => isset($_SERVER['HTTPS']),
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_name('iribhm_admin');
session_start();

// ── Brute-force lockout ──────────────────────────────────────────────────────
$LOCKOUT_FILE   = sys_get_temp_dir() . '/iribhm_admin_lockout_' . md5(__DIR__) . '.json';
$MAX_ATTEMPTS   = 5;
$LOCKOUT_SECS   = 900; // 15 min

function load_lockout(): array {
    global $LOCKOUT_FILE;
    if (!file_exists($LOCKOUT_FILE)) return ['attempts' => 0, 'locked_until' => 0];
    return json_decode(file_get_contents($LOCKOUT_FILE), true) ?? ['attempts' => 0, 'locked_until' => 0];
}

function save_lockout(array $data): void {
    global $LOCKOUT_FILE;
    file_put_contents($LOCKOUT_FILE, json_encode($data));
}

function is_locked_out(): bool {
    $l = load_lockout();
    return $l['locked_until'] > time();
}

function record_failed_attempt(): void {
    global $MAX_ATTEMPTS, $LOCKOUT_SECS;
    $l = load_lockout();
    $l['attempts']++;
    if ($l['attempts'] >= $MAX_ATTEMPTS) {
        $l['locked_until'] = time() + $LOCKOUT_SECS;
        $l['attempts'] = 0;
    }
    save_lockout($l);
}

function clear_lockout(): void {
    save_lockout(['attempts' => 0, 'locked_until' => 0]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function json_out(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function require_auth(): void {
    if (empty($_SESSION['admin_authenticated'])) {
        json_out(['error' => 'Unauthorized'], 401);
    }
}

// ── Router ───────────────────────────────────────────────────────────────────
$action = $_GET['action'] ?? ($_POST['action'] ?? '');
if ($action === '' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $body   = json_decode(file_get_contents('php://input'), true) ?? [];
    $action = $body['action'] ?? '';
} else {
    $body = [];
}

switch ($action) {

    case 'status':
        json_out(['authenticated' => !empty($_SESSION['admin_authenticated'])]);

    case 'login':
        $body     = $body ?: (json_decode(file_get_contents('php://input'), true) ?? []);
        $username = trim($body['username'] ?? '');
        $password = $body['password'] ?? '';

        if (is_locked_out()) {
            json_out(['error' => 'Too many failed attempts. Try again in 15 minutes.'], 429);
        }

        if ($username !== ($ADMIN_USERNAME ?? '') ||
            !password_verify($password, $ADMIN_PASSWORD_HASH ?? '')) {
            record_failed_attempt();
            json_out(['error' => 'Invalid credentials.'], 401);
        }

        // Success
        clear_lockout();
        session_regenerate_id(true);
        $_SESSION['admin_authenticated'] = true;
        $_SESSION['admin_user']          = $username;
        $_SESSION['admin_login_time']    = time();
        json_out(['ok' => true, 'username' => $username]);

    case 'logout':
        $_SESSION = [];
        session_destroy();
        json_out(['ok' => true]);

    default:
        json_out(['error' => 'Unknown action.'], 400);
}
