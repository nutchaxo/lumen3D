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
function trust_file(): string { return __DIR__ . '/plugin-trust.json'; }
function data_web(): string { return admin_root() . '/DATA_WEB'; }
function changelog_dir(): string { return admin_root() . '/changelog'; }
function modules_dir(): string { return admin_root() . '/js/modules'; }

// ── JSON I/O ────────────────────────────────────────────────────────────────
// NOTE: no `: never` return type here — this file is require_once'd by the PUBLIC
// plugins.php on the advertised PHP >= 7.4 floor, and `never` is 8.1+ syntax (a
// parse error on 7.4/8.0 would 500 every plugin-discovery request). It exits anyway.
function admin_json_out(array $data, int $code = 200) {
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
    if (strlen($password) < 8) return [false, 400, ['error' => 'weak_password']];
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
    if (strlen($new) < 8) return [false, 400, ['error' => 'weak_password']];
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

// ── Plugin trust (twin of dev_server.py trust module) ─────────────────────────
// Canonical hash + classification, so a PHP host gates untrusted plugins like the
// Python server. Hash MUST match (validated by tests/plugin-trust-vector.json).

const TRUST_SCHEME = 'lumen-plugin-trust/1';
const TRUST_HASH_EXT = ['js', 'json', 'mjs', 'css', 'html'];
const SANDBOX_CAP_ALLOWLIST = [
    'toolbar.addButton', 'ui.toast', 'ui.download', 'viewer.getCanvasBlob',
    'viewer.getInfo', 'viewer.setRenderMode', 'channels.getState', 'events.subscribe',
];
// Fallback effective caps for a sandboxed plugin that declares none — MUST match
// dev_server.py:_SANDBOX_DEFAULT_CAPS (twin parity), not the full allowlist.
const SANDBOX_DEFAULT_CAPS = ['toolbar.addButton', 'ui.toast', 'viewer.getInfo'];

/** {relpath: sha256hex} over raw bytes for every identity-bearing file. */
function admin_plugin_file_hashes(string $modDir): array {
    $out = [];
    if (!is_dir($modDir)) return $out;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($modDir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (!$f->isFile()) continue;
        $ext = strtolower($f->getExtension());
        if (!in_array($ext, TRUST_HASH_EXT, true) || $f->getFilename()[0] === '.') continue;
        $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($modDir) + 1));
        $out[$rel] = hash_file('sha256', $f->getPathname());
    }
    ksort($out);
    return $out;
}

function admin_plugin_hash(array $fileHashes): string {
    ksort($fileHashes);
    $lines = [];
    foreach ($fileHashes as $rel => $h) $lines[] = "$rel:$h";
    return hash('sha256', TRUST_SCHEME . "\n" . implode("\n", $lines));
}

function admin_release_manifest(): ?array {
    $vj = admin_root() . '/version.json';
    if (!is_file($vj)) return null;
    $d = admin_read_json($vj);
    return (is_array($d) && isset($d['files']) && is_array($d['files'])) ? $d['files'] : null;
}

function admin_load_trust(): array {
    $d = admin_read_json(trust_file());
    return (is_array($d) && isset($d['approvals']) && is_array($d['approvals'])) ? $d['approvals'] : [];
}

function admin_save_trust(array $approvals): bool {
    return admin_write_json(trust_file(), ['version' => 1, 'approvals' => array_values($approvals)]);
}

function admin_plugin_declared_caps(string $modDir): array {
    $meta = admin_read_json($modDir . '/plugin.json');
    $req = is_array($meta) && isset($meta['sandboxCapabilities']) ? $meta['sandboxCapabilities'] : [];
    return is_array($req) ? array_values(array_intersect($req, SANDBOX_CAP_ALLOWLIST)) : [];
}

/** Returns ['tier'=>..,'hash'=>..,'mode'=>?,'caps'=>?,'reason'=>..]. Twin of _classify_plugin. */
function admin_plugin_wants_sandbox(string $modDir): bool {
    $meta = admin_read_json($modDir . '/plugin.json');
    return is_array($meta) && ($meta['sandbox'] ?? null) === true;
}

/** Dev-trust: a .git checkout served to a LOOPBACK client only (mirrors the Python
 *  loopback gate). Single source of truth so the classifier and the plugin_trust
 *  endpoint report the same value. */
function admin_dev_trust(): bool {
    $remote = $_SERVER['REMOTE_ADDR'] ?? '';
    return is_dir(admin_root() . '/.git') && in_array($remote, ['127.0.0.1', '::1', ''], true);
}

function admin_classify_plugin(string $pluginPath, string $modDir, array $approvals, ?array $manifest): array {
    $fh = admin_plugin_file_hashes($modDir);
    $hash = admin_plugin_hash($fh);
    $base = ['hash' => $hash];
    // `sandbox: true` decides the LANE — a trusted sandbox plugin still runs in the
    // iframe (in-page it would crash on LumenPlugin.*). Twin of _plugin_wants_sandbox.
    $wantsSandbox = admin_plugin_wants_sandbox($modDir);
    $declared = admin_plugin_declared_caps($modDir);
    $sbCaps = array_values(array_intersect($declared ?: SANDBOX_DEFAULT_CAPS, SANDBOX_CAP_ALLOWLIST));
    $trusted = function ($tier, $mode, $reason, $caps) use ($base, $wantsSandbox, $sbCaps) {
        if ($wantsSandbox) return $base + ['tier' => 'sandboxed', 'mode' => 'sandboxed',
            'caps' => ($caps !== null ? $caps : $sbCaps), 'reason' => $reason . ' + sandbox:true'];
        return $base + ['tier' => $tier, 'mode' => $mode, 'caps' => $caps, 'reason' => $reason];
    };
    // bundled: content match against version.json
    if ($manifest !== null && $fh) {
        $prefix = "js/modules/$pluginPath/";
        $allMatch = true;
        foreach ($fh as $rel => $h) { if (($manifest[$prefix . $rel] ?? null) !== $h) { $allMatch = false; break; } }
        if ($allMatch) return $trusted('bundled', null, 'in release manifest', null);
    }
    // Find this plugin's approval (if any), validated against the CURRENT bytes.
    $ap = null;
    foreach ($approvals as $a) { if (($a['path'] ?? null) === $pluginPath) { $ap = $a; break; } }
    $eff = [];
    $apValid = $ap !== null && ($ap['sha256'] ?? null) === $hash;
    if ($apValid) {
        $approved = $ap['caps'] ?? [];
        $disk = admin_plugin_declared_caps($modDir);
        if (array_diff($disk, $approved)) { $apValid = false; }  // requests caps beyond approved
        else { $eff = array_values(array_intersect($disk ?: SANDBOX_DEFAULT_CAPS, $approved, SANDBOX_CAP_ALLOWLIST)); }
    }
    // A 'sandboxed' approval is a deliberate containment choice — it wins even on a
    // dev-trust host (else the operator's sandbox decision is silently overridden).
    if ($apValid && ($ap['mode'] ?? '') === 'sandboxed')
        return $base + ['tier' => 'sandboxed', 'mode' => 'sandboxed', 'caps' => $eff, 'reason' => 'operator-approved'];

    // dev: .git checkout, but ONLY for a loopback request (a LAN/public visitor to a
    // PHP host with .git present must not get dev-trust — mirrors the Python loopback gate).
    if (admin_dev_trust())
        return $trusted('dev', null, 'dev-trust (loopback git checkout)', null);

    if ($apValid && ($ap['mode'] ?? '') === 'trusted')
        return $trusted('approved-trusted', 'trusted', 'operator-approved', $eff);
    if ($ap !== null && !$apValid)
        return $base + ['tier' => 'untrusted', 'reason' => 'approval void — content or caps changed'];
    return $base + ['tier' => 'untrusted', 'reason' => 'not approved'];
}

// ── Plugin/platform compatibility (twin of js/core/compat.js + dev_server.py) ──
// Validated against tests/compat-vector.json. Fail-closed: a present-but-unreadable
// declaration is INCOMPATIBLE. Fail-open only for an unknown platform version.

/** "1.4.1-rc" → [1,4,1] (numeric dotted prefix) | null when no leading number. */
function admin_compat_nums($s): ?array {
    if (!preg_match('/^(\d+(?:\.\d+){0,2})/', trim((string)$s), $m)) return null;
    return array_map('intval', explode('.', $m[1]));
}

function admin_compat_cmp(array $a, array $b): int {
    for ($i = 0; $i < 3; $i++) {
        $x = $a[$i] ?? 0; $y = $b[$i] ?? 0;
        if ($x !== $y) return $x < $y ? -1 : 1;
    }
    return 0;
}

/** Bare token → ['any'] | ['exact',nums] | ['range',min,maxEx] | null. */
function admin_compat_bare(string $tok): ?array {
    $tok = trim($tok);
    if ($tok === '*' || $tok === 'x') return ['any'];
    $stripped = preg_replace('/\.[x*]$/i', '', $tok);
    $wild = $stripped !== $tok;
    if (!preg_match('/^\d+(\.\d+){0,2}$/', $stripped)) return null;
    $nums = admin_compat_nums($stripped);
    if (count($nums) === 3 && !$wild) return ['exact', $nums];
    $maxEx = $nums; $maxEx[count($maxEx) - 1]++;
    return ['range', $nums, $maxEx];
}

/** One RANGE comparator → [op, nums] | null (op '' = bare). */
function admin_compat_comparator(string $tok) {
    if (!preg_match('/^(>=|<=|>|<|=|\^|~)?(.+)$/', trim($tok), $m)) return null;
    $op = $m[1] ?? ''; $body = $m[2];
    if ($op === '') { $b = admin_compat_bare($body); return $b === null ? null : ['bare', $b]; }
    if (!preg_match('/^\d+(\.\d+){0,2}([.-].*)?$/', trim($body))) return null;
    $nums = admin_compat_nums($body);
    return $nums === null ? null : [$op, $nums];
}

function admin_compat_pred_ok(array $cmp, array $v): bool {
    [$op, $a] = $cmp;
    if ($op === 'bare') {
        $b = $a;
        if ($b[0] === 'any') return true;
        if ($b[0] === 'exact') return admin_compat_cmp($v, $b[1]) === 0;
        return admin_compat_cmp($v, $b[1]) >= 0 && admin_compat_cmp($v, $b[2]) < 0;
    }
    switch ($op) {
        case '>=': return admin_compat_cmp($v, $a) >= 0;
        case '>':  return admin_compat_cmp($v, $a) > 0;
        case '<=': return admin_compat_cmp($v, $a) <= 0;
        case '<':  return admin_compat_cmp($v, $a) < 0;
        case '=':  return admin_compat_cmp($v, $a) === 0;
        case '^':  return admin_compat_cmp($v, $a) >= 0 && admin_compat_cmp($v, [$a[0] + 1, 0, 0]) < 0;
        case '~':  return admin_compat_cmp($v, $a) >= 0 && admin_compat_cmp($v, [$a[0], ($a[1] ?? 0) + 1, 0]) < 0;
    }
    return false;
}

/** @return array{0:bool,1:string} [ok, reason]. See js/core/compat.js for the contract. */
function admin_compat_satisfies($platformVersion, $decl): array {
    if ($decl === null) return [true, 'no constraint declared'];
    if ($platformVersion === null) return [true, 'platform version unknown — gate disabled'];
    $v = admin_compat_nums($platformVersion);
    if ($v === null) return [true, 'platform version unreadable — gate disabled'];

    if (is_string($decl)) {
        $tokens = preg_split('/\s+/', trim($decl), -1, PREG_SPLIT_NO_EMPTY);
        if (!$tokens) return [false, 'empty constraint'];
        foreach ($tokens as $tok) {
            $cmp = admin_compat_comparator($tok);
            if ($cmp === null) return [false, "unreadable constraint token \"$tok\""];
            if (!admin_compat_pred_ok($cmp, $v)) return [false, "platform $platformVersion fails \"$decl\""];
        }
        return [true, "matches \"$decl\""];
    }

    if (is_array($decl)) {
        if (!$decl) return [false, 'empty constraint list'];
        // A JSON object decodes to an associative array in PHP; only a 0-based
        // sequential list is the OR-list form. Reject object form (fail-closed),
        // matching js/core/compat.js (Array.isArray=false) and dev_server.py
        // (isinstance list=false) — otherwise PHP would iterate object VALUES and
        // fail-OPEN on e.g. {"min":"1.4"} that the two twins reject.
        if (array_keys($decl) !== range(0, count($decl) - 1)) {
            return [false, 'unreadable constraint (object form not supported)'];
        }
        foreach ($decl as $item) {
            $hasOp = is_string($item) && preg_match('/^(>=|<=|>|<|=|\^|~)/', trim($item));
            if (!is_string($item) || $hasOp) return [false, "invalid list item (bare tokens only)"];
            $b = admin_compat_bare($item);
            if ($b === null) return [false, "unreadable list token \"$item\""];
            if ($b[0] === 'any') return [true, 'wildcard'];
            $ok = $b[0] === 'exact'
                ? admin_compat_cmp($v, $b[1]) === 0
                : (admin_compat_cmp($v, $b[1]) >= 0 && admin_compat_cmp($v, $b[2]) < 0);
            if ($ok) return [true, "matches \"$item\""];
        }
        return [false, "platform $platformVersion matches none of the list"];
    }

    return [false, 'unreadable constraint (wrong type)'];
}

// ── Plugin marketplace (curated, signed, operator-initiated) ──────────────────
// PHP twin of dev_server.py's marketplace. Reuses the trust helpers above so an
// install lands in the SAME trust gate as any plugin. SEPARATE key from the core
// release key (install.php $PINNED_PUBKEY): plugin-signing authority is decoupled.
// Empty key ⇒ sha256 integrity only + warning; SET ⇒ signature MANDATORY (fail-closed).
const MARKETPLACE_PUBKEY      = '7f5feaddd11dac38c836f556cd7d7b09fe9a7bda307c20e1e062aafa0ab27d3e';
const MARKETPLACE_CATALOG_URL = 'https://raw.githubusercontent.com/nutchaxo/lumen3D/main/marketplace/marketplace-catalog.json';
const MARKETPLACE_MAX_ZIP     = 8388608;

function mkt_fetch_bytes(string $url, int $limit): ?string {
    // Prefer cURL (enabled on most shared hosts even when allow_url_fopen is OFF —
    // matching install.php's http_get_small); fall back to the stream wrapper only
    // when allow_url_fopen is available. A host with neither returns null. The write
    // callback caps the body at $limit+1 bytes so an oversized response can't balloon
    // memory (a truncated body then fails the signature check — fail-closed).
    if (function_exists('curl_init')) {
        $buf = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FOLLOWLOCATION  => true,
            CURLOPT_MAXREDIRS       => 5,
            CURLOPT_PROTOCOLS       => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT  => 20,
            CURLOPT_TIMEOUT         => 60,
            CURLOPT_SSL_VERIFYPEER  => true,
            CURLOPT_SSL_VERIFYHOST  => 2,
            CURLOPT_USERAGENT       => 'lumen3d-admin',
            CURLOPT_WRITEFUNCTION   => function ($c, $chunk) use (&$buf, $limit) {
                $buf .= $chunk;
                return strlen($buf) > $limit + 1 ? 0 : strlen($chunk);   // 0 aborts (over cap)
            },
        ]);
        curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($buf !== '' && $code >= 200 && $code < 300) return substr($buf, 0, $limit);
    }
    if (filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
        $ctx = stream_context_create(['http' => ['timeout' => 60, 'header' => "User-Agent: lumen3d-admin\r\n"]]);
        $d = @file_get_contents($url, false, $ctx, 0, $limit + 1);
        if ($d !== false) return substr($d, 0, $limit);
    }
    return null;
}

/** Verify a detached Ed25519 sig over $data against the pinned marketplace key.
 *  Fail-closed once keyed; true = OK/not-required, false = refused. */
function mkt_verify_signature(string $data, ?string $sigUrl): bool {
    if (MARKETPLACE_PUBKEY === '') return true;                     // unkeyed: integrity only
    if (!function_exists('sodium_crypto_sign_verify_detached')) return false;
    if (!$sigUrl) return false;
    $sig = mkt_fetch_bytes($sigUrl, 4096);
    if ($sig === null) return false;
    $sig = trim($sig);
    if (preg_match('/^[0-9a-fA-F]{128}$/', $sig)) $sig = hex2bin($sig);
    if (strlen($sig) !== 64) return false;
    $pub = @hex2bin(MARKETPLACE_PUBKEY);
    return $pub !== false && strlen($pub) === 32 && sodium_crypto_sign_verify_detached($sig, $data, $pub);
}

/** @return array{0:bool,1:mixed} [ok, plugins | error-string] */
function mkt_fetch_catalog(): array {
    if (MARKETPLACE_CATALOG_URL === '') return [false, 'marketplace_not_configured'];
    $raw = mkt_fetch_bytes(MARKETPLACE_CATALOG_URL, 1 << 20);
    if ($raw === null) return [false, 'catalog_fetch_failed'];
    if (!mkt_verify_signature($raw, MARKETPLACE_CATALOG_URL . '.sig')) return [false, 'catalog_signature_invalid'];
    $d = json_decode($raw, true);
    if (!is_array($d) || !isset($d['plugins']) || !is_array($d['plugins'])) return [false, 'invalid_catalog'];
    return [true, $d['plugins']];
}

function mkt_list(): array {
    $base = ['configured' => MARKETPLACE_CATALOG_URL !== '', 'signed' => MARKETPLACE_PUBKEY !== ''];
    if (MARKETPLACE_CATALOG_URL === '') return $base + ['plugins' => []];
    [$ok, $res] = mkt_fetch_catalog();
    if (!$ok) return $base + ['error' => $res, 'plugins' => []];
    $ver = admin_max_version(changelog_dir());
    $installed = array_map(fn($p) => $p['path'], admin_list_plugins());
    $out = [];
    foreach ($res as $e) {
        if (!is_array($e)) continue;
        $pid = (string)($e['id'] ?? '');
        $placement = $e['placement'] ?? null;
        $path = in_array($placement, ['tools', 'channels', 'shaders'], true) ? "$placement/$pid" : null;
        [$c, $cr] = admin_compat_satisfies($ver, $e['platformCompat'] ?? null);
        $out[] = [
            'id' => $pid, 'name' => $e['name'] ?? $pid, 'placement' => $placement, 'subtype' => $e['subtype'] ?? null,
            'description' => $e['description'] ?? null, 'creator' => $e['creator'] ?? null, 'icon' => $e['icon'] ?? null,
            'platformCompat' => $e['platformCompat'] ?? null, 'sandboxCapabilities' => $e['sandboxCapabilities'] ?? null,
            'latestVersion' => $e['latestVersion'] ?? null, 'recommended' => $e['recommended'] ?? false,
            'installed' => $path ? in_array($path, $installed, true) : false, 'compat' => $c, 'compatReason' => $cr,
        ];
    }
    return $base + ['plugins' => $out];
}

function mkt_rmrf(string $p): void {
    if (is_dir($p) && !is_link($p)) { foreach (scandir($p) as $c) { if ($c !== '.' && $c !== '..') mkt_rmrf("$p/$c"); } @rmdir($p); }
    elseif (is_file($p) || is_link($p)) @unlink($p);
}

/** Hardened extraction → dir holding plugin.json, or null. */
function mkt_extract_zip(string $zipPath, string $dest): ?string {
    if (!class_exists('ZipArchive')) return null;
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) return null;
    $total = 0;
    if ($zip->numFiles > 500) { $zip->close(); return null; }
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $st = $zip->statIndex($i);
        $name = $st['name'];
        $first = explode('/', $name)[0];
        if ($name === '' || $name[0] === '/' || strpos($name, '\\') !== false || strpos($first, ':') !== false || in_array('..', explode('/', $name), true)) { $zip->close(); return null; }
        $total += (int)$st['size'];
        if ($total > 24 * 1024 * 1024) { $zip->close(); return null; }
    }
    @mkdir($dest, 0755, true);
    $zip->extractTo($dest);
    $zip->close();
    if (is_file("$dest/plugin.json")) return $dest;
    $subs = array_values(array_filter(glob("$dest/*") ?: [], 'is_dir'));
    if (count($subs) === 1 && is_file($subs[0] . '/plugin.json')) return $subs[0];
    return null;
}

/** @return array{0:int,1:array} [httpStatus, payload] */
function mkt_install(string $catalogId, string $password): array {
    if (MARKETPLACE_CATALOG_URL === '') return [400, ['error' => 'marketplace_not_configured']];
    $rec = admin_credential();
    if (!$rec || !admin_verify_password($password, $rec['password_pbkdf2'] ?? '')) return [401, ['error' => 'bad_password']];
    [$ok, $res] = mkt_fetch_catalog();
    if (!$ok) return [502, ['error' => $res]];
    $entry = null;
    foreach ($res as $e) { if (is_array($e) && (string)($e['id'] ?? '') === $catalogId) { $entry = $e; break; } }
    if (!$entry) return [404, ['error' => 'unknown_catalog_id']];
    $placement = $entry['placement'] ?? ''; $pid = (string)($entry['id'] ?? '');
    if (!in_array($placement, ['tools', 'channels', 'shaders'], true) || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/', $pid)) return [400, ['error' => 'bad_plugin_id']];
    $path = "$placement/$pid"; $targetDir = modules_dir() . "/$placement/$pid";
    if (is_dir($targetDir)) return [409, ['error' => 'already_installed']];
    [$c, $cr] = admin_compat_satisfies(admin_max_version(changelog_dir()), $entry['platformCompat'] ?? null);
    if (!$c) return [409, ['error' => 'incompatible', 'detail' => $cr]];
    $assetUrl = $entry['assetUrl'] ?? null; $sumsUrl = $entry['sumsUrl'] ?? null; $sigUrl = $entry['sigUrl'] ?? null;
    if (!$assetUrl) return [400, ['error' => 'no_asset']];
    $tmp = sys_get_temp_dir() . '/mkt-' . bin2hex(random_bytes(6));
    @mkdir($tmp, 0755, true);
    $zipData = mkt_fetch_bytes($assetUrl, MARKETPLACE_MAX_ZIP);
    if ($zipData === null) { mkt_rmrf($tmp); return [502, ['error' => 'download_failed']]; }
    $zipPath = "$tmp/plugin.zip"; file_put_contents($zipPath, $zipData);
    $digest = hash('sha256', $zipData);
    // Fast path: when the catalog is signed (MARKETPLACE_PUBKEY set), mkt_fetch_catalog
    // already verified its Ed25519 signature fail-closed, so entry.sha256 is AUTHENTICATED.
    // Trust it and skip the extra per-plugin SHA256SUMS + .sig round-trips (2 fewer GitHub
    // fetches per install — the install was ~12s from 5 sequential raw.githubusercontent
    // requests). Fall back to the detached SHA256SUMS chain when the catalog is unsigned.
    if (MARKETPLACE_PUBKEY !== '' && !empty($entry['sha256'])) {
        if (strtolower((string)$entry['sha256']) !== $digest) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'sha256']]; }
    } elseif ($sumsUrl) {
        $sumsRaw = mkt_fetch_bytes($sumsUrl, 1 << 16);
        if ($sumsRaw === null || !mkt_verify_signature($sumsRaw, $sigUrl)) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'signature']]; }
        $sums = [];
        foreach (explode("\n", $sumsRaw) as $ln) { if (preg_match('/^([0-9a-fA-F]{64})\s+\*?(.+)$/', trim($ln), $mm)) $sums[$mm[2]] = strtolower($mm[1]); }
        $zipName = basename($assetUrl);
        $expected = $sums[$zipName] ?? (count($sums) === 1 ? reset($sums) : null);
        if (!$expected || $expected !== $digest) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'sha256']]; }
    } elseif (!empty($entry['sha256'])) {
        if (strtolower((string)$entry['sha256']) !== $digest) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'sha256']]; }
    } else { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'no_hash']]; }
    $proot = mkt_extract_zip($zipPath, "$tmp/x");
    if ($proot === null) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'extract']]; }
    $meta = admin_read_json("$proot/plugin.json");
    if (!is_array($meta) || (string)($meta['id'] ?? '') !== $pid || (isset($meta['placement']) && $meta['placement'] !== $placement)) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'metadata']]; }
    @mkdir(dirname($targetDir), 0755, true);
    if (!@rename($proot, $targetDir)) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'move']]; }
    mkt_rmrf($tmp);
    $serverHash = admin_plugin_hash(admin_plugin_file_hashes($targetDir));
    $declared = admin_plugin_declared_caps($targetDir);
    $wantsSandbox = (($meta['sandbox'] ?? null) === true) || ($placement === 'tools' && !empty($declared));
    $mode = $wantsSandbox ? 'sandboxed' : 'trusted';
    $approvals = array_values(array_filter(admin_load_trust(), fn($a) => ($a['path'] ?? '') !== $path));
    $approvals[] = ['path' => $path, 'sha256' => $serverHash, 'mode' => $mode, 'caps' => array_values($declared), 'at' => date('c'), 'by' => $rec['username'] ?? 'admin'];
    admin_save_trust($approvals);
    return [200, ['ok' => true, 'path' => $path, 'mode' => $mode]];
}

/** @return array{0:int,1:array} */
function mkt_uninstall(string $path): array {
    if (!preg_match('#^(tools|channels|shaders)/[A-Za-z0-9_][A-Za-z0-9._-]*$#', $path)) return [400, ['error' => 'bad_path']];
    $target = modules_dir() . '/' . $path;
    if (!is_dir($target)) return [404, ['error' => 'not_installed']];
    if (strpos($path, 'shaders/') === 0) {
        $disabled = admin_load_disabled();
        $enabled = array_filter(admin_list_plugins(), fn($p) => ($p['placement'] ?? '') === 'shaders' && !in_array($p['path'], $disabled, true));
        $paths = array_map(fn($p) => $p['path'], $enabled);
        if (count($paths) <= 1 && in_array($path, $paths, true)) return [409, ['error' => 'last_shader']];
    }
    mkt_rmrf($target);
    $approvals = array_values(array_filter(admin_load_trust(), fn($a) => ($a['path'] ?? '') !== $path));
    admin_save_trust($approvals);
    return [200, ['ok' => true]];
}
