<?php
/**
 * IRIBHM Microscopy Platform — Admin shared library (PHP fallback)
 * ================================================================
 * Mirrors the credential / stats / plugin / version logic of dev_server.py so a
 * PHP host behaves like the Python dev server. Authored to match the Python
 * contracts byte-for-byte where it matters:
 *  - the credential hash uses the SAME PBKDF2 format as Python
 *    (`pbkdf2_sha256$iters$salthex$hashhex`), so api/admin_credential.json is
 *    interoperable between the two servers.
 *  - setup is create-exclusive (fopen 'x'); it can never overwrite a live credential.
 *
 * NOTE: the PHP fallback is for legacy hosts only — the recommended server is
 * dev_server.py. This file is authored without a PHP runtime to test against; it
 * tracks the Python implementation. On Apache/Nginx, the api/.htaccess (and the
 * server config) must block direct access to the *.json state files below.
 */

declare(strict_types=1);

const ADMIN_PBKDF2_ITERS = 200000;
const ADMIN_SESSION_TTL  = 28800; // 8h
const GITHUB_REPO        = 'nutchaxo/lumen3D';

function admin_root(): string { return dirname(__DIR__); }
function api_dir(): string { return __DIR__; }
function cred_file(): string { return __DIR__ . '/admin_credential.json'; }
function stats_file(): string { return __DIR__ . '/stats.json'; }
function disabled_file(): string { return __DIR__ . '/disabled-plugins.json'; }
function data_web(): string { return admin_root() . '/DATA_WEB'; }
function changelog_dir(): string { return admin_root() . '/changelog'; }
function modules_dir(): string { return admin_root() . '/js/modules'; }

// ── JSON I/O ────────────────────────────────────────────────────────────────
function admin_json_out(array $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function admin_read_json(string $path): ?array {
    if (!file_exists($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
}

/** Atomic-ish write: temp sibling + rename (atomic on the same filesystem). */
function admin_write_json(string $path, array $data): bool {
    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $tmp = tempnam($dir, '.tmp-');
    if ($tmp === false) return false;
    if (@file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)) === false) {
        @unlink($tmp); return false;
    }
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    @chmod($path, 0600);
    return true;
}

// ── Password hashing (matches dev_server.py PBKDF2 format) ───────────────────
function admin_hash_password(string $plain, ?string $saltHex = null, int $iters = ADMIN_PBKDF2_ITERS): string {
    $salt = $saltHex !== null ? hex2bin($saltHex) : random_bytes(16);
    // length=0 → full digest (32 bytes for sha256) → 64 hex chars, like Python's dk.hex()
    $hashHex = hash_pbkdf2('sha256', $plain, $salt, $iters, 0, false);
    return 'pbkdf2_sha256$' . $iters . '$' . bin2hex($salt) . '$' . $hashHex;
}

function admin_verify_password(string $plain, string $stored): bool {
    if ($stored === '' ) return false;
    if (strncmp($stored, 'pbkdf2_sha256$', 14) === 0) {
        $parts = explode('$', $stored);
        if (count($parts) !== 4) return false;
        [$scheme, $iters, $saltHex, $hashHex] = $parts;
        $computed = admin_hash_password($plain, $saltHex, (int)$iters);
        return hash_equals($computed, $stored);
    }
    // Legacy unsalted sha256 (kept for backward compat, like Python)
    return hash_equals($stored, hash('sha256', $plain));
}

// ── Credential store ────────────────────────────────────────────────────────
function admin_credential(): ?array { return admin_read_json(cred_file()); }
function admin_credential_exists(): bool { return file_exists(cred_file()); }

function admin_credential_record(string $username, string $password): array {
    $now = date('c');
    $username = trim($username) ?: 'admin';
    return [
        'version' => 1,
        'username' => $username,
        'password_pbkdf2' => admin_hash_password($password),
        'created' => $now,
        'rotated' => $now,
    ];
}

/** Create the credential ONLY if absent. Returns [ok, status, payload].
 *  fopen('x') is the anti-overwrite guarantee (create-exclusive). */
function admin_setup_credential(string $username, string $password): array {
    if (strlen($password) < 4) return [false, 400, ['error' => 'weak_password']];
    $fp = @fopen(cred_file(), 'x');               // create-exclusive
    if ($fp === false) {
        return file_exists(cred_file())
            ? [false, 409, ['error' => 'already_configured']]
            : [false, 500, ['error' => 'setup_failed']];
    }
    $rec = admin_credential_record($username, $password);
    fwrite($fp, json_encode($rec, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fclose($fp);
    @chmod(cred_file(), 0600);
    return [true, 200, ['ok' => true, 'username' => $rec['username']]];
}

/** Rotate password — requires the current one. Returns [ok, status, payload]. */
function admin_change_credential(string $current, string $new): array {
    $rec = admin_credential();
    if (!$rec) return [false, 409, ['error' => 'not_configured']];
    if (!admin_verify_password($current, $rec['password_pbkdf2'] ?? '')) return [false, 401, ['error' => 'bad_current']];
    if (strlen($new) < 4) return [false, 400, ['error' => 'weak_password']];
    $newrec = admin_credential_record($rec['username'] ?? 'admin', $new);
    $newrec['created'] = $rec['created'] ?? $newrec['created'];
    return admin_write_json(cred_file(), $newrec)
        ? [true, 200, ['ok' => true]]
        : [false, 500, ['error' => 'write_failed']];
}

function admin_check_credentials(string $username, string $password): bool {
    $rec = admin_credential();
    if (!$rec) return false;
    if ($username !== ($rec['username'] ?? null)) return false;
    return admin_verify_password($password, $rec['password_pbkdf2'] ?? '');
}

// ── Sessions + CSRF (PHP native sessions) ───────────────────────────────────
function admin_session_start(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_set_cookie_params([
        'lifetime' => ADMIN_SESSION_TTL, 'path' => '/',
        'secure' => isset($_SERVER['HTTPS']), 'httponly' => true, 'samesite' => 'Lax',
    ]);
    session_name('iribhm_admin');
    session_start();
}

function admin_is_auth(): bool { return !empty($_SESSION['admin_authenticated']); }

function admin_csrf(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return $_SESSION['csrf'];
}

function admin_check_csrf(): bool {
    $hdr = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    return !empty($_SESSION['csrf']) && hash_equals((string)$_SESSION['csrf'], (string)$hdr);
}

/** Enforce POST + CSRF for state-changing actions. Exits on failure. */
function admin_require_write(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
    if (!admin_check_csrf()) admin_json_out(['error' => 'Invalid or missing CSRF token'], 403);
}

// ── Path safety (mirrors _safe_dataset_dir) ─────────────────────────────────
function admin_safe_dataset(string $id): ?array {
    $parts = explode('/', $id, 2);
    if (count($parts) !== 2) return null;
    [$type, $folder] = [trim($parts[0]), trim($parts[1])];
    if (!in_array($type, ['fixed', 'live', 'tracking'], true)) return null;
    if ($folder === '.' || $folder === '..' || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/', $folder)) return null;
    $base = realpath(data_web() . '/' . $type);
    $dir  = $base ? realpath($base . '/' . $folder) : false;
    if ($base && $dir && strpos($dir, $base) === 0) return [$type, $folder, $dir];
    // dir may not exist yet on realpath; fall back to a non-resolved but validated path
    return [$type, $folder, data_web() . '/' . $type . '/' . $folder];
}

// ── Usage stats ─────────────────────────────────────────────────────────────
function admin_load_stats(): array {
    $d = admin_read_json(stats_file());
    if (!is_array($d)) $d = [];
    $d['global']   = $d['global']   ?? ['visits' => 0, 'views' => 0, 'downloads' => 0, 'since' => date('c')];
    $d['daily']    = $d['daily']    ?? [];
    $d['datasets'] = $d['datasets'] ?? [];
    return $d;
}

function admin_record_event(string $kind, ?string $datasetId = null): void {
    $map = ['visit' => 'visits', 'view' => 'views', 'download' => 'downloads'];
    if (!isset($map[$kind])) return;
    $field = $map[$kind];
    $today = date('Y-m-d');
    // flock-guarded read-modify-write
    $fp = @fopen(stats_file(), 'c+');
    if ($fp === false) return;
    @flock($fp, LOCK_EX);
    $raw = stream_get_contents($fp);
    $d = $raw ? (json_decode($raw, true) ?: []) : [];
    $d['global']   = $d['global']   ?? ['visits' => 0, 'views' => 0, 'downloads' => 0, 'since' => date('c')];
    $d['daily']    = $d['daily']    ?? [];
    $d['datasets'] = $d['datasets'] ?? [];
    $d['global'][$field] = (int)($d['global'][$field] ?? 0) + 1;
    $d['daily'][$today][$field] = (int)($d['daily'][$today][$field] ?? 0) + 1;
    if ($datasetId && in_array($kind, ['view', 'download'], true)) {
        $d['datasets'][$datasetId][$field] = (int)($d['datasets'][$datasetId][$field] ?? 0) + 1;
        if ($kind === 'view') $d['datasets'][$datasetId]['lastViewed'] = date('c');
    }
    rewind($fp);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($d, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    @flock($fp, LOCK_UN);
    fclose($fp);
    @chmod(stats_file(), 0600);
}

// ── Plugins ─────────────────────────────────────────────────────────────────
function admin_list_plugins(): array {
    $plugins = [];
    foreach (['tools', 'channels', 'shaders'] as $placement) {
        $base = modules_dir() . '/' . $placement;
        if (!is_dir($base)) continue;
        foreach (scandir($base) as $name) {
            if ($name[0] === '.' || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/', $name)) continue;
            $meta = admin_read_json($base . '/' . $name . '/plugin.json');
            if (!$meta) continue;
            if (!empty($meta['placement']) && $meta['placement'] !== $placement) continue;
            $meta['placement'] = $placement;
            $meta['path'] = $placement . '/' . $name;
            $plugins[] = $meta;
        }
    }
    return $plugins;
}

function admin_load_disabled(): array {
    $d = admin_read_json(disabled_file());
    return is_array($d) && isset($d['disabled']) && is_array($d['disabled']) ? $d['disabled'] : [];
}

function admin_save_disabled(array $disabled): bool {
    $disabled = array_values(array_unique($disabled));
    sort($disabled);
    return admin_write_json(disabled_file(), ['disabled' => $disabled]);
}

// ── Versioning ──────────────────────────────────────────────────────────────
function admin_max_version(string $dir): ?string {
    if (!is_dir($dir)) return null;
    $best = null; $bestTuple = [0, 0, 0];
    foreach (scandir($dir) as $f) {
        if (preg_match('/^changelog_(\d+)\.(\d+)\.(\d+)\.md$/', $f, $m)) {
            $t = [(int)$m[1], (int)$m[2], (int)$m[3]];
            if ($t > $bestTuple) { $bestTuple = $t; $best = "$m[1].$m[2].$m[3]"; }
        }
    }
    return $best;
}

function admin_version_tuple(string $s): array {
    preg_match_all('/\d+/', $s, $m);
    $n = array_map('intval', array_slice($m[0], 0, 3));
    return array_pad($n, 3, 0);
}

function admin_preprocess_version(): ?string {
    $f = admin_root() . '/preprocess/run_preprocess.py';
    if (is_file($f)) {
        $txt = @file_get_contents($f);
        if ($txt && preg_match('/__version__\s*=\s*["\']([\d.]+)["\']/', $txt, $m)) return $m[1];
    }
    return admin_max_version(admin_root() . '/preprocess/changelog');
}
