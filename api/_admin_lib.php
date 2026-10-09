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
function cred_file(): string { return defined('LUMEN_CRED_FILE') ? (string)LUMEN_CRED_FILE : __DIR__ . '/admin_credential.json'; }
/** Where the platform keeps its private runtime state (locks, lockout store, session
 *  files, caches): api/, which is never served. A test points it elsewhere. */
function admin_private_dir(): string { return defined('LUMEN_PRIVATE_DIR') ? (string)LUMEN_PRIVATE_DIR : __DIR__; }
function stats_file(): string { return __DIR__ . '/stats.json'; }
function disabled_file(): string { return __DIR__ . '/disabled-plugins.json'; }
function trust_file(): string { return __DIR__ . '/plugin-trust.json'; }
function data_web(): string { return defined('LUMEN_DATA_WEB') ? (string)LUMEN_DATA_WEB : admin_root() . '/DATA_WEB'; }
function changelog_dir(): string { return admin_root() . '/changelog'; }
function modules_dir(): string { return admin_root() . '/js/modules'; }
function uploads_root(): string { return admin_root() . '/uploads'; }
function config_dir(): string { return admin_root() . '/config'; }

// ── Dataset types ────────────────────────────────────────────────────────────
// ONE vocabulary, used simultaneously as: the directory under DATA_WEB/ and
// uploads/staging/, the first segment of a dataset id, metadata.json's "type",
// what plugin.json#dataTypes declares, the ?type= filter value and the badge-<type>
// CSS suffix. Every PHP type list must derive from these two constants — they were
// three independent literals before, and they drifted.
// Twins: dev_server.py ALLOWED_TYPE_DIRS / upload_staging.py ALLOWED_TYPE_DIRS /
// js/core/utils.js Utils.DATASET_TYPES.
const LUMEN_DATASET_TYPES = ['3d', '2d', 'live'];
// Types whose data is a brick pyramid. '2d' is a single photograph, so it has no
// bricks/ tree (twin of VOLUME_TYPE_DIRS / Utils.VOLUME_DATASET_TYPES).
const LUMEN_VOLUME_DATASET_TYPES = ['3d', 'live'];

// ── Filesystem permissions (keep the site editable over FTP/SFTP) ────────────
// Twin of install.php's perms_* helpers. The web root belongs to the hosting
// account (that is who uploaded the site); where PHP runs as a DIFFERENT system
// user — www-data, apache, a shared php-fpm pool — everything the platform writes
// would be owned by PHP in 0755/0644, and the account could then neither upload
// into those directories nor delete what is inside them: POSIX takes the right to
// delete a file from its PARENT DIRECTORY, not from the file.
//
// When that split is detected we create the DATA trees world-writable (0777/0666) so
// the site stays under its owner's control — never the code, see
// admin_code_file_mode(); on a correctly configured host (suEXEC, per-user
// pool) nothing changes. Secrets (api/*.json) keep 0600 — they are never meant to be
// edited by hand, and deleting them only needs the parent directory.
// Override with LUMEN_DIR_MODE / LUMEN_FILE_MODE.

function admin_perms_owner_split(): bool {
    static $split = null;
    if ($split !== null) return $split;
    if (DIRECTORY_SEPARATOR !== '/') return $split = false;
    $owner = @fileowner(admin_root());
    if ($owner === false) return $split = false;
    if (function_exists('posix_geteuid')) return $split = ($owner !== posix_geteuid());
    $probe = admin_root() . '/.lumen-perm-probe';
    if (@file_put_contents($probe, '') === false) return $split = false;
    $mine = @fileowner($probe);
    @unlink($probe);
    return $split = ($mine !== false && $mine !== $owner);
}

function admin_mode_override(string $env): ?int {
    $v = getenv($env);
    if ($v === false || !preg_match('/^0?[0-7]{3,4}$/', trim((string)$v))) return null;
    return (int)intval(trim((string)$v), 8);
}

/**
 * Modes are INHERITED FROM THE WEB ROOT, because that directory is what the hosting
 * account was set up with and it already encodes how this host shares the site.
 * The common shared-hosting layout is `web1945:client 0770`: PHP and the SFTP login
 * are different users of the SAME GROUP, so files must be GROUP-writable (0770/0660)
 * — creating them 0755/0644 locks the operator out just as effectively as an owner
 * mismatch, and creating them 0777/0666 would grant far more than needed.
 *
 * Escalation stays for the one case inheritance cannot cover: the root grants write
 * to nobody but its owner AND PHP is not that owner — then world-writable is the only
 * way for the account to manage its own site.
 * @return array{0:int,1:int} [dirMode, fileMode]
 */
function admin_base_modes(): array {
    static $cached = null;
    if ($cached !== null) return $cached;
    if (DIRECTORY_SEPARATOR !== '/') return $cached = [0755, 0644];
    $perms = @fileperms(admin_root());
    if ($perms === false) return $cached = [0755, 0644];
    $base = $perms & 0777;
    if (admin_perms_owner_split() && ($base & 0022) === 0) $base |= 0022;    // owner-only root, PHP is not it
    $dir  = $base | 0700;                          // the platform must always traverse/write its own tree
    $file = ($base & 0666) | 0600;                 // data files are never executable
    return $cached = [$dir, $file];
}

function admin_dir_mode(): int  { return admin_mode_override('LUMEN_DIR_MODE')  ?? admin_base_modes()[0]; }
function admin_file_mode(): int { return admin_mode_override('LUMEN_FILE_MODE') ?? admin_base_modes()[1]; }

/**
 * Modes for the platform's own CODE (everything outside the data trees, and any
 * script-like file wherever it sits). The world-writable escalation above exists so
 * the hosting account can manage what PHP writes into its DATA trees; applied to
 * api/*.php, .htaccess or js/ it would let any other account on a shared machine
 * replace the code PHP executes. Code is therefore never group/world-widened beyond
 * what the web root itself grants to its group, and is always world-READABLE (the
 * web server may be a different user than PHP). An operator override is honoured
 * but can never make code world-writable.
 */
function admin_code_dir_mode(): int {
    $o = admin_mode_override('LUMEN_DIR_MODE');
    if ($o !== null) return ($o & ~0002) | 0755;
    if (DIRECTORY_SEPARATOR !== '/') return 0755;
    $root = @fileperms(admin_root());
    return $root === false ? 0755 : ((($root & 0777) & 0775) | 0755);
}

function admin_code_file_mode(): int {
    $o = admin_mode_override('LUMEN_FILE_MODE');
    if ($o !== null) return ($o & 0664) | 0644;
    if (DIRECTORY_SEPARATOR !== '/') return 0644;
    $root = @fileperms(admin_root());
    return $root === false ? 0644 : ((($root & 0777) & 0664) | 0644);
}

/** Path relative to the web root ('' when outside it). */
function admin_rel_path(string $path): string {
    $p    = str_replace('\\', '/', $path);
    $root = rtrim(str_replace('\\', '/', admin_root()), '/');
    if ($p === $root) return '';
    if (strncmp($p, $root . '/', strlen($root) + 1) !== 0) return '';
    return substr($p, strlen($root) + 1);
}

/** A file an interpreter or the web server would act on: never widened. */
function admin_is_code_file(string $path): bool {
    return (bool)preg_match('/(\.(php\d?|phtml|phps|phar|py|pl|cgi|sh)|(^|\/)\.htaccess|(^|\/)\.user\.ini)$/i',
                            str_replace('\\', '/', $path));
}

/** The operator-managed data trees, the only place the escalated modes apply. */
function admin_is_data_rel(string $rel): bool {
    foreach (['DATA_WEB', 'uploads', 'config', 'api/page-drafts'] as $prefix) {
        if ($rel === $prefix || strncmp($rel, $prefix . '/', strlen($prefix) + 1) === 0) return true;
    }
    return false;
}

function admin_dir_mode_for(string $path): int {
    return admin_is_data_rel(admin_rel_path($path)) ? admin_dir_mode() : admin_code_dir_mode();
}

function admin_file_mode_for(string $path): int {
    if (admin_is_code_file($path)) return admin_code_file_mode();
    return admin_is_data_rel(admin_rel_path($path)) ? admin_file_mode() : admin_code_file_mode();
}

/** mkdir + explicit chmod on every level created (mkdir's mode is umask-masked). */
function admin_make_dir(string $path): bool {
    if (is_dir($path)) return true;
    if (!@mkdir($path, admin_dir_mode_for($path), true) && !is_dir($path)) return false;
    $cur  = rtrim(str_replace('\\', '/', $path), '/');
    $root = rtrim(str_replace('\\', '/', admin_root()), '/');
    while ($cur !== '' && strlen($cur) > strlen($root) && strncmp($cur, $root, strlen($root)) === 0) {
        @chmod($cur, admin_dir_mode_for($cur));
        $cur = dirname($cur);
    }
    return true;
}

function admin_fix_file_mode(string $path): void { @chmod($path, admin_file_mode_for($path)); }

/** Apply the resolved modes to a freshly extracted subtree (zip extraction ignores them). */
function mkt_modes_recursive(string $base): void {
    if (DIRECTORY_SEPARATOR !== '/' || !is_dir($base)) return;
    @chmod($base, admin_dir_mode_for($base));
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS | FilesystemIterator::UNIX_PATHS),
        RecursiveIteratorIterator::SELF_FIRST,
        RecursiveIteratorIterator::CATCH_GET_CHILD
    );
    foreach ($it as $path => $info) {
        if ($info->isLink()) continue;
        @chmod((string)$path, $info->isDir() ? admin_dir_mode_for((string)$path) : admin_file_mode_for((string)$path));
    }
}

/** Secrets that keep 0600 whatever the site mode is. */
function admin_is_secret_path(string $rel): bool {
    return strncmp($rel, 'api/', 4) === 0 && substr($rel, -5) === '.json';
}

/** Read-only view of the permission situation, for the admin UI. */
function admin_permissions_report(): array {
    $root = admin_root();
    $owner = @fileowner($root);
    $php = function_exists('posix_geteuid') ? posix_geteuid() : null;
    $name = function ($uid) {
        if ($uid === null || $uid === false) return null;
        if (function_exists('posix_getpwuid')) { $p = @posix_getpwuid((int)$uid); if (is_array($p) && isset($p['name'])) return $p['name']; }
        return (string)$uid;
    };
    $gname = function ($gid) {
        if ($gid === false || $gid === null) return null;
        if (function_exists('posix_getgrgid')) { $g = @posix_getgrgid((int)$gid); if (is_array($g) && isset($g['name'])) return $g['name']; }
        return (string)$gid;
    };
    return [
        'posix' => DIRECTORY_SEPARATOR === '/',
        'split' => admin_perms_owner_split(),
        'siteOwner' => $name($owner),
        'siteGroup' => $gname(@filegroup($root)),
        'phpUser' => $name($php),
        'dirMode' => sprintf('%04o', admin_dir_mode()),
        'fileMode' => sprintf('%04o', admin_file_mode()),
        // Code (api/*.php, .htaccess, js/…) is never widened like the data trees.
        'codeDirMode' => sprintf('%04o', admin_code_dir_mode()),
        'codeFileMode' => sprintf('%04o', admin_code_file_mode()),
        'rootMode' => sprintf('%04o', @fileperms($root) & 0777),
        // How the site is shared decides the modes; surfacing it turns a support
        // round-trip ("why 0770?") into something the operator can read off the card.
        'groupWritable' => ((@fileperms($root) & 0020) !== 0),
    ];
}

/**
 * Re-apply the resolved modes over the whole install — the repair path for a site
 * created before this logic existed (or by another tool). Symlinks are never
 * followed and nothing outside the web root is touched.
 * @return array{fixed:int,failed:int,scanned:int,dirMode:string,fileMode:string,split:bool}
 */
function admin_apply_tree_modes(int $maxEntries = 200000): array {
    // A DATA_WEB holding brick packs can reach tens of thousands of files; the walk
    // must not die on the default 30 s limit halfway through. Re-runs are cheap:
    // entries already at the target mode are skipped.
    @set_time_limit(300);
    $root = rtrim(str_replace('\\', '/', admin_root()), '/');
    $out = ['fixed' => 0, 'failed' => 0, 'scanned' => 0,
            'dirMode' => sprintf('%04o', admin_dir_mode()), 'fileMode' => sprintf('%04o', admin_file_mode()),
            'split' => admin_perms_owner_split()];
    if (DIRECTORY_SEPARATOR !== '/') return $out;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS | FilesystemIterator::UNIX_PATHS),
        RecursiveIteratorIterator::SELF_FIRST,
        RecursiveIteratorIterator::CATCH_GET_CHILD          // an unreadable dir must not abort the walk
    );
    foreach ($it as $path => $info) {
        if (++$out['scanned'] > $maxEntries) break;
        if ($info->isLink()) continue;
        $rel = ltrim(substr(str_replace('\\', '/', (string)$path), strlen($root)), '/');
        if ($rel === '' || admin_is_secret_path($rel)) continue;
        $want = $info->isDir() ? admin_dir_mode_for((string)$path) : admin_file_mode_for((string)$path);
        if ((@fileperms((string)$path) & 0777) === $want) continue;
        if (@chmod((string)$path, $want)) $out['fixed']++; else $out['failed']++;
    }
    return $out;
}

// ── JSON I/O ────────────────────────────────────────────────────────────────
// NOTE: no `: never` return type here — this file is require_once'd by the PUBLIC
// plugins.php on the advertised PHP >= 7.4 floor, and `never` is 8.1+ syntax (a
// parse error on 7.4/8.0 would 500 every plugin-discovery request). It exits anyway.
function admin_json_out(array $data, int $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache');
    [$status, $json] = admin_json_body($data, JSON_UNESCAPED_UNICODE);
    if ($status) http_response_code($status);
    echo $json;
    exit;
}

/** JSON for an API answer that is never an empty body: [status override or 0, json]. */
function admin_json_body(array $data, int $flags): array {
    $json = json_encode($data, $flags);
    if ($json === false) {
        // One non-UTF-8 byte (a folder name from an old SFTP client) must not turn
        // the whole answer into an empty 200 the client cannot tell from a crash.
        $json = json_encode($data, $flags | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    }
    if ($json !== false) return [0, $json];
    return [500, (string)json_encode(['error' => 'encode_failed', 'detail' => json_last_error_msg()])];
}

function admin_read_json(string $path): ?array {
    if (!file_exists($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
}

/** Atomic write of a private api/ document (0600): temp sibling + rename. */
function admin_write_json(string $path, array $data): bool {
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false) return false;
    return lumen_write_file_atomic($path, $json, 0600);
}

/**
 * Replace $path with $body without a reader ever seeing a partial file: the bytes
 * go to a sibling temp file (same directory ⇒ same filesystem, so rename() is an
 * atomic swap of the directory entry, also on Windows where PHP renames with
 * MOVEFILE_REPLACE_EXISTING). tempnam() is not used: when the directory is not
 * writable it silently falls back to the system temp dir, and the rename then
 * crosses devices. $mode null = the platform's mode for that path.
 */
function lumen_write_file_atomic(string $path, string $body, ?int $mode = null): bool {
    $dir = dirname($path);
    if (!is_dir($dir) && !admin_make_dir($dir)) return false;
    $tmp = $dir . '/.tmp-' . bin2hex(random_bytes(6));
    $fh = @fopen($tmp, 'xb');
    if ($fh === false) return false;
    $ok = @fwrite($fh, $body) === strlen($body);
    $ok = @fflush($fh) && $ok;
    @fclose($fh);
    if (!$ok || !@rename($tmp, $path)) { @unlink($tmp); return false; }
    @chmod($path, $mode ?? admin_file_mode_for($path));
    return true;
}

/**
 * Run $fn while holding an exclusive lock that guards $path's read-modify-write.
 * The lock lives in api/.locks/ (never served, never inside a dataset folder), keyed
 * by the target path; when no lock file can be created the work still runs — every
 * write is atomic anyway, the lock only prevents lost updates between writers.
 */
function lumen_with_lock(string $path, callable $fn) {
    $key = substr(hash('sha256', str_replace('\\', '/', $path)), 0, 32) . '.lock';
    $fh = false;
    foreach ([admin_private_dir() . '/.locks', sys_get_temp_dir() . '/lumen-locks-' . substr(md5(__DIR__), 0, 12)] as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) continue;
        $fh = @fopen($dir . '/' . $key, 'c');
        if ($fh !== false) break;
    }
    if ($fh !== false) @flock($fh, LOCK_EX);
    try {
        return $fn();
    } finally {
        if ($fh !== false) { @flock($fh, LOCK_UN); @fclose($fh); }
    }
}

/**
 * Decode a JSON document that will be written back. json_decode(…, true) turns an
 * empty object `{}` into an empty PHP array, which json_encode then writes as `[]`:
 * a map silently became a list after one save on this backend (the Python twin keeps
 * `{}`). Objects are decoded as objects first; non-empty ones become associative
 * arrays (so callers keep array access), empty ones stay stdClass and re-encode as
 * `{}`. Returns null when $raw is not JSON.
 */
function lumen_json_decode_doc(string $raw) {
    $v = json_decode($raw, false);
    if ($v === null && trim($raw) !== 'null') return null;
    return lumen_json_unobject($v);
}

function lumen_json_unobject($v) {
    if ($v instanceof stdClass) {
        $a = get_object_vars($v);
        if (!$a) return new stdClass();
        // An object whose keys happen to read 0..n-1 would re-encode as a list.
        if (array_keys($a) === range(0, count($a) - 1)) {
            foreach ($a as $k => $x) $v->$k = lumen_json_unobject($x);
            return $v;
        }
        foreach ($a as $k => $x) $a[$k] = lumen_json_unobject($x);
        return $a;
    }
    if (is_array($v)) {
        foreach ($v as $k => $x) $v[$k] = lumen_json_unobject($x);
    }
    return $v;
}

/** Read a JSON object document for a read-modify-write (see lumen_json_decode_doc). */
function lumen_read_json_doc(string $path): ?array {
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    if (!is_string($raw)) return null;
    $d = lumen_json_decode_doc($raw);
    return is_array($d) ? $d : null;
}

/** Atomic write of a PUBLIC JSON document (metadata.json, config/*.json). */
function lumen_write_json_doc(string $path, array $doc): bool {
    $json = json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    if ($json === false) return false;   // malformed UTF-8: refuse rather than blank the file
    return lumen_write_file_atomic($path, $json);
}

/** The request body as a JSON object, or null when it is absent or not an object. */
function lumen_request_json(): ?array {
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || $raw === '') return null;
    $d = lumen_json_decode_doc($raw);
    if ($d instanceof stdClass) return [];                       // `{}`: an empty object
    if (!is_array($d) || ($d && array_keys($d) === range(0, count($d) - 1))) return null;   // a list is not an object
    return $d;
}

/** A scalar request field as a string, or null when it is absent or not a string. */
function lumen_str($v): ?string {
    return is_string($v) ? $v : null;
}

// ── Password hashing (matches dev_server.py PBKDF2 format) ───────────────────
function admin_hash_password(string $plain, ?string $saltHex = null, int $iters = ADMIN_PBKDF2_ITERS): string {
    $salt = $saltHex !== null ? @hex2bin($saltHex) : random_bytes(16);
    if (!is_string($salt)) $salt = '';
    // length=0 → full digest (32 bytes for sha256) → 64 hex chars, like Python's dk.hex()
    $hashHex = hash_pbkdf2('sha256', $plain, $salt, max(1, $iters), 0, false);
    return 'pbkdf2_sha256$' . $iters . '$' . bin2hex($salt) . '$' . $hashHex;
}

/** A credential hash written before salted PBKDF2: bare sha256 hex of the password. */
function admin_is_legacy_hash(string $stored): bool {
    return (bool)preg_match('/^[0-9a-f]{64}\z/i', $stored);
}

/**
 * Verify a password against the stored PBKDF2 hash. A legacy unsalted sha256 is
 * NEVER accepted here: the login path upgrades it on the spot (admin_login_verify)
 * and every other password check — re-auth for plugin approval/installation, the
 * current password of a change — refuses it.
 */
function admin_verify_password(string $plain, string $stored): bool {
    if (strncmp($stored, 'pbkdf2_sha256$', 14) !== 0) return false;
    $parts = explode('$', $stored);
    if (count($parts) !== 4 || !ctype_digit($parts[1]) || !preg_match('/^[0-9a-f]+\z/i', $parts[2])) return false;
    $computed = admin_hash_password($plain, $parts[2], (int)$parts[1]);
    return hash_equals($stored, $computed);
}

/** A fixed hash the login runs against when the username is wrong or no credential
 *  exists, so an unknown user costs the same PBKDF2 as a known one (no timing oracle). */
function admin_dummy_hash(): string {
    return 'pbkdf2_sha256$' . ADMIN_PBKDF2_ITERS . '$' . str_repeat('00', 16) . '$' . str_repeat('0', 64);
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

/**
 * The credential's identity for sessions: changes whenever the password does. A
 * session remembers the stamp it was opened under, so rotating the password signs
 * every OTHER session out (admin_is_auth refuses a stale stamp).
 */
function admin_credential_stamp(?array $rec = null): string {
    $rec = $rec ?? admin_credential();
    if (!is_array($rec)) return '';
    return substr(hash('sha256', (string)($rec['password_pbkdf2'] ?? '') . '|' . (string)($rec['rotated'] ?? '')), 0, 32);
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
    if (!admin_verify_password($current, (string)($rec['password_pbkdf2'] ?? ''))) return [false, 401, ['error' => 'bad_current']];
    if (strlen($new) < 8) return [false, 400, ['error' => 'weak_password']];
    $newrec = admin_credential_record((string)($rec['username'] ?? 'admin'), $new);
    $newrec['created'] = $rec['created'] ?? $newrec['created'];
    return admin_write_json(cred_file(), $newrec)
        ? [true, 200, ['ok' => true]]
        : [false, 500, ['error' => 'write_failed']];
}

/**
 * Login check with constant work: the PBKDF2 always runs (against the real hash, or
 * a dummy when the username is wrong or no credential exists) and the username is
 * compared in constant time, so the response time says nothing about which half was
 * wrong. A legacy unsalted sha256 credential is accepted once, here, and rewritten
 * as PBKDF2 before the login succeeds; when that rewrite fails the login is refused.
 * @return array{0:bool,1:?string} [ok, error code when refused for a reason other than bad credentials]
 */
function admin_login_verify(string $username, string $password): array {
    $rec = admin_credential();
    $stored = is_array($rec) && is_string($rec['password_pbkdf2'] ?? null) ? $rec['password_pbkdf2'] : '';
    $known  = is_array($rec) && is_string($rec['username'] ?? null) ? $rec['username'] : '';
    $userOk = $known !== '' && hash_equals($known, $username);
    if (admin_is_legacy_hash($stored)) {
        admin_verify_password($password, admin_dummy_hash());     // same cost as the PBKDF2 path
        $pwOk = hash_equals(strtolower($stored), hash('sha256', $password));
        if (!($userOk && $pwOk)) return [false, null];
        $upgraded = $rec;
        $upgraded['password_pbkdf2'] = admin_hash_password($password);
        $upgraded['version'] = 1;
        if (!admin_write_json(cred_file(), $upgraded)) return [false, 'credential_upgrade_failed'];
        return [true, null];
    }
    $pwOk = admin_verify_password($password, $userOk && $stored !== '' ? $stored : admin_dummy_hash());
    return [$userOk && $pwOk && $stored !== '', null];
}

function admin_check_credentials(string $username, string $password): bool {
    return admin_login_verify($username, $password)[0];
}

// ── Client address + trusted proxies ─────────────────────────────────────────
// Behind a reverse proxy every request arrives from the proxy's address, so a
// lockout keyed on REMOTE_ADDR would put all visitors in one bucket. The forwarded
// headers are only believed when REMOTE_ADDR is a proxy the operator declared —
// otherwise any client could pick its own bucket by sending X-Forwarded-For.
// Declared in the environment (LUMEN_TRUSTED_PROXIES="10.0.0.1 192.168.0.0/16",
// e.g. SetEnv in the vhost) or in api/trusted-proxies.json {"proxies": [...]}
// (denied over HTTP like every api/*.json).

function admin_trusted_proxies(): array {
    static $list = null;
    if ($list !== null) return $list;
    $raw = getenv('LUMEN_TRUSTED_PROXIES');
    if (!is_string($raw) || $raw === '') $raw = (string)($_SERVER['LUMEN_TRUSTED_PROXIES'] ?? '');
    $items = preg_split('/[\s,]+/', $raw, -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $doc = admin_read_json(__DIR__ . '/trusted-proxies.json');
    if (is_array($doc) && is_array($doc['proxies'] ?? null)) {
        foreach ($doc['proxies'] as $p) if (is_string($p) && trim($p) !== '') $items[] = trim($p);
    }
    return $list = array_values(array_unique($items));
}

/** $ip inside $cidr ('a.b.c.d', 'a.b.c.d/n', IPv6 likewise). */
function admin_ip_in_cidr(string $ip, string $cidr): bool {
    $parts = explode('/', $cidr, 2);
    $net = @inet_pton(trim($parts[0]));
    $bin = @inet_pton($ip);
    if ($net === false || $bin === false || strlen($net) !== strlen($bin)) return false;
    $bits = isset($parts[1]) && ctype_digit($parts[1]) ? (int)$parts[1] : strlen($net) * 8;
    $bits = max(0, min($bits, strlen($net) * 8));
    $bytes = intdiv($bits, 8);
    if (substr($net, 0, $bytes) !== substr($bin, 0, $bytes)) return false;
    $rem = $bits % 8;
    if ($rem === 0) return true;
    $mask = (0xFF << (8 - $rem)) & 0xFF;
    return (ord($net[$bytes]) & $mask) === (ord($bin[$bytes]) & $mask);
}

function admin_ip_trusted(string $ip): bool {
    foreach (admin_trusted_proxies() as $p) if (admin_ip_in_cidr($ip, $p)) return true;
    return false;
}

/** Whether the request came through a declared proxy. */
function admin_via_trusted_proxy(): bool {
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    return $remote !== '' && admin_ip_trusted($remote);
}

/** The client's address: REMOTE_ADDR, or — behind a declared proxy — the right-most
 *  X-Forwarded-For hop that is not itself a declared proxy. */
function admin_client_ip(): string {
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    if (!admin_via_trusted_proxy()) return $remote !== '' ? $remote : 'unknown';
    $hops = array_map('trim', explode(',', (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '')));
    for ($i = count($hops) - 1; $i >= 0; $i--) {
        $h = $hops[$i];
        if ($h === '' || @inet_pton($h) === false) break;
        if (!admin_ip_trusted($h)) return $h;
    }
    $real = trim((string)($_SERVER['HTTP_X_REAL_IP'] ?? ''));
    return ($real !== '' && @inet_pton($real) !== false) ? $real : $remote;
}

/** HTTPS as the CLIENT sees it (TLS may end at a declared proxy). */
function admin_request_is_https(): bool {
    $https = strtolower((string)($_SERVER['HTTPS'] ?? ''));
    if ($https !== '' && $https !== 'off') return true;
    if (admin_via_trusted_proxy()) {
        return strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0])) === 'https';
    }
    return false;
}

// ── Login throttling ─────────────────────────────────────────────────────────
// Every password check (login, change_password, plugin approval/installation)
// RESERVES an attempt before running PBKDF2, under an exclusive lock: N parallel
// requests take N slots, so a burst can never get more guesses than the budget —
// a check-then-verify design let every request of a burst pass the check before
// any failure was recorded. A success gives its slot back.
//
// Two budgets: per client address (10 attempts, then 15 min locked) and a global
// soft ceiling (200 attempts per 15 min across all addresses) that caps a guessing
// run spread over many addresses. The store lives under api/ (never served); the
// shared system temp dir is only a fallback, and when neither is writable the check
// fails CLOSED — no lockout store must never mean no lockout.

const ADMIN_BF_MAX_ATTEMPTS = 10;
const ADMIN_BF_WINDOW       = 900;
const ADMIN_BF_LOCK         = 900;
const ADMIN_BF_GLOBAL_MAX   = 200;

function admin_bf_dir(): ?string {
    static $dir = false;
    if ($dir !== false) return $dir;
    $candidates = defined('LUMEN_PRIVATE_DIR')
        ? [admin_private_dir() . '/.bruteforce']
        : [__DIR__ . '/.bruteforce', sys_get_temp_dir() . '/lumen-bf-' . substr(hash('sha256', __DIR__), 0, 16)];
    // Last resort: PHP's own session directory. It is writable wherever a login can
    // work at all (the session lives there when api/.sessions cannot be created), so
    // a host whose api/ is read-only and whose temp dir is outside open_basedir does
    // not lock its operator out for good.
    if (!defined('LUMEN_PRIVATE_DIR')) {
        $ssp = (string)session_save_path();
        $ssp = trim((string)substr($ssp, (int)strrpos(';' . $ssp, ';')));   // "N;MODE;/path" → "/path"
        if ($ssp !== '') $candidates[] = rtrim($ssp, '/\\') . '/lumen-bf-' . substr(hash('sha256', __DIR__), 0, 16);
    }
    foreach ($candidates as $d) {
        if (!is_dir($d) && !@mkdir($d, 0700, true) && !is_dir($d)) continue;
        if (is_writable($d)) return $dir = $d;
    }
    return $dir = null;
}

/** Run $fn(array &$state, int $now) under the store lock; the state is then
 *  persisted atomically. Null when the store is unusable. */
function admin_bf_transaction(callable $fn) {
    $dir = admin_bf_dir();
    if ($dir === null) return null;
    $lock = @fopen($dir . '/store.lock', 'c');
    if ($lock === false) return null;
    if (!@flock($lock, LOCK_EX)) { @fclose($lock); return null; }
    try {
        $path = $dir . '/state.json';
        $raw = is_file($path) ? @file_get_contents($path) : '';
        $state = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
        if (!is_array($state)) $state = [];
        $state['ips'] = is_array($state['ips'] ?? null) ? $state['ips'] : [];
        $state['global'] = is_array($state['global'] ?? null) ? $state['global'] : ['start' => 0, 'count' => 0];
        $now = time();
        foreach ($state['ips'] as $k => $b) {               // bounded: idle buckets expire
            if (!is_array($b) || ((int)($b['until'] ?? 0) <= $now && (int)($b['start'] ?? 0) + ADMIN_BF_WINDOW <= $now)) {
                unset($state['ips'][$k]);
            }
        }
        $result = $fn($state, $now);
        if (!$state['ips']) $state['ips'] = new stdClass();
        $json = json_encode($state);
        if ($json === false || !lumen_write_file_atomic($path, $json, 0600)) return null;
        return $result;
    } finally {
        @flock($lock, LOCK_UN);
        @fclose($lock);
    }
}

/**
 * Reserve one password attempt for the current client.
 * @return array{0:bool,1:int,2:?string} [allowed, retryAfterSeconds, reason]
 */
function admin_bf_reserve(): array {
    $key = hash('sha256', admin_client_ip());
    $r = admin_bf_transaction(function (array &$state, int $now) use ($key) {
        $b = $state['ips'][$key] ?? ['start' => $now, 'count' => 0, 'until' => 0];
        if ((int)($b['until'] ?? 0) > $now) return [false, (int)$b['until'] - $now, 'locked'];
        // A fresh bucket once the window has passed or an armed lock has expired
        // (twin of dev_server.py _bf_reserve).
        $until = (int)($b['until'] ?? 0);
        if ((int)($b['start'] ?? 0) + ADMIN_BF_WINDOW <= $now || ($until > 0 && $until <= $now)) {
            $b = ['start' => $now, 'count' => 0, 'until' => 0];
        }
        $g = $state['global'];
        if ((int)($g['start'] ?? 0) + ADMIN_BF_WINDOW <= $now) $g = ['start' => $now, 'count' => 0];
        if ((int)($g['count'] ?? 0) >= ADMIN_BF_GLOBAL_MAX) {
            return [false, max(1, (int)$g['start'] + ADMIN_BF_WINDOW - $now), 'global'];
        }
        $b['count'] = (int)($b['count'] ?? 0) + 1;
        if ($b['count'] >= ADMIN_BF_MAX_ATTEMPTS) $b['until'] = $now + ADMIN_BF_LOCK;
        $g['count'] = (int)($g['count'] ?? 0) + 1;
        $state['ips'][$key] = $b;
        $state['global'] = $g;
        return [true, 0, null];
    });
    return $r ?? [false, 60, 'store_unavailable'];
}

/** The attempt succeeded: the client's budget is reset and its global slot returned. */
function admin_bf_success(): void {
    $key = hash('sha256', admin_client_ip());
    admin_bf_transaction(function (array &$state, int $now) use ($key) {
        unset($state['ips'][$key]);
        $state['global']['count'] = max(0, (int)($state['global']['count'] ?? 0) - 1);
        return true;
    });
}

/** Exit with the throttling answer when the attempt is refused. */
function admin_bf_gate(): void {
    [$ok, $retry, $reason] = admin_bf_reserve();
    if ($ok) return;
    header('Retry-After: ' . max(1, $retry));
    if ($reason === 'store_unavailable') admin_json_out(['error' => 'lockout_store_unavailable'], 503);
    admin_json_out(['error' => 'too_many_attempts', 'retryAfter' => $retry], 429);
}

/** Password re-authentication for a privileged admin action, throttled like a login. */
function admin_reauth($password): bool {
    if (!is_string($password)) return false;
    admin_bf_gate();
    $rec = admin_credential();
    $ok = is_array($rec) && admin_verify_password($password, (string)($rec['password_pbkdf2'] ?? ''));
    if ($ok) admin_bf_success();
    return $ok;
}

// ── Sessions + CSRF (PHP native sessions) ───────────────────────────────────
// Server-side rules on top of the cookie:
//  * use_strict_mode: an id the server never issued is refused (no session fixation
//    by planting a chosen id);
//  * a private save path under api/ when it can be created: the host's shared one is
//    swept by ITS gc_maxlifetime (often 24 min), which signed admins out mid-edit
//    long before the 8 h the cookie promises;
//  * an ABSOLUTE expiry 8 h after login, whatever the activity (a stolen cookie does
//    not live as long as it keeps being used);
//  * the credential stamp: a password change signs every other session out.

function admin_session_dir(): ?string {
    $d = admin_private_dir() . '/.sessions';
    if (!is_dir($d) && !@mkdir($d, 0700, true) && !is_dir($d)) return null;
    return is_writable($d) ? $d : null;
}

function admin_session_start(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    if (!headers_sent()) {
        @ini_set('session.use_strict_mode', '1');
        @ini_set('session.use_only_cookies', '1');
        @ini_set('session.use_trans_sid', '0');
        @ini_set('session.gc_maxlifetime', (string)ADMIN_SESSION_TTL);
        $dir = admin_session_dir();
        if ($dir !== null) {
            session_save_path($dir);
            @ini_set('session.gc_probability', '1');
            @ini_set('session.gc_divisor', '100');
        }
        session_set_cookie_params([
            'lifetime' => ADMIN_SESSION_TTL, 'path' => '/',
            'secure' => admin_request_is_https(), 'httponly' => true, 'samesite' => 'Lax',
        ]);
    }
    session_name('iribhm_admin');
    @session_start();
}

/** Start the session only when the client already holds one — a public request must
 *  not create a session file and a Set-Cookie per anonymous visitor. */
function admin_session_resume(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    if (!isset($_COOKIE['iribhm_admin']) || !is_string($_COOKIE['iribhm_admin'])) return;
    admin_session_start();
}

/** Mark the session authenticated (fresh id, login time, credential stamp). */
function admin_session_login(string $username, bool $rotateCsrf = true): void {
    session_regenerate_id(true);
    if ($rotateCsrf) unset($_SESSION['csrf']);    // a token minted before login never carries over
    $_SESSION['admin_authenticated'] = true;
    $_SESSION['admin_user'] = $username;
    $_SESSION['auth_at'] = time();
    $_SESSION['cred_stamp'] = admin_credential_stamp();
}

function admin_is_auth(): bool {
    if (empty($_SESSION['admin_authenticated'])) return false;
    $at = $_SESSION['auth_at'] ?? null;
    if (!is_int($at) || time() - $at > ADMIN_SESSION_TTL) return false;
    $stamp = $_SESSION['cred_stamp'] ?? null;
    return is_string($stamp) && $stamp !== '' && hash_equals(admin_credential_stamp(), $stamp);
}

function admin_csrf(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    return $_SESSION['csrf'];
}

function admin_check_csrf(): bool {
    $hdr = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    return !empty($_SESSION['csrf']) && is_string($hdr) && hash_equals((string)$_SESSION['csrf'], $hdr);
}

/** Enforce POST + CSRF for state-changing actions. Exits on failure. */
function admin_require_write(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') admin_json_out(['error' => 'Method not allowed (use POST)'], 405);
    if (!admin_check_csrf()) admin_json_out(['error' => 'Invalid or missing CSRF token'], 403);
}

/**
 * A request that carries no CSRF token yet (login, logout) must still prove it was
 * sent by this site's own script: a JSON content type (a cross-site form or a
 * no-cors fetch can only send text/plain, urlencoded or multipart), and a browser
 * origin, when it states one, equal to this host.
 */
function admin_same_origin_json(): bool {
    $ctRaw = (string)($_SERVER['CONTENT_TYPE'] ?? ($_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
    if (strtolower(trim(explode(';', $ctRaw)[0])) !== 'application/json') return false;
    // Sec-Fetch-Site is set by the browser itself and settles the question (twin of
    // dev_server.py _same_origin_json_refusal): comparing Origin with Host as well
    // would refuse the operator's own login behind a reverse proxy that rewrites Host
    // and was not declared. Origin is the fallback for browsers that send no
    // Sec-Fetch-Site.
    $site = strtolower(trim((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')));
    if ($site !== '') return $site === 'same-origin' || $site === 'none';
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin === '') return true;
    if ($origin === 'null') return false;
    $host = (admin_via_trusted_proxy() && !empty($_SERVER['HTTP_X_FORWARDED_HOST']))
        ? trim(explode(',', (string)$_SERVER['HTTP_X_FORWARDED_HOST'])[0])
        : (string)($_SERVER['HTTP_HOST'] ?? '');
    $oHost = parse_url($origin, PHP_URL_HOST);
    $oPort = parse_url($origin, PHP_URL_PORT);
    if (!is_string($oHost) || $host === '') return false;
    // A Host header may carry the default port the Origin omits, or the reverse.
    $norm = fn(string $h) => (string)preg_replace('/:(80|443)$/', '', strtolower($h));
    return $norm($host) === $norm($oHost . ($oPort ? ':' . $oPort : ''));
}

// ── Path safety (mirrors _safe_dataset_dir) ─────────────────────────────────
function admin_safe_dataset(string $id): ?array {
    $parts = explode('/', $id, 2);
    if (count($parts) !== 2) return null;
    [$type, $folder] = [trim($parts[0]), trim($parts[1])];
    if (!in_array($type, LUMEN_DATASET_TYPES, true)) return null;
    if ($folder === '.' || $folder === '..' || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $folder)) return null;
    $base = realpath(data_web() . '/' . $type);
    $dir  = $base ? realpath($base . '/' . $folder) : false;
    if ($base && $dir && strpos($dir, $base) === 0) return [$type, $folder, $dir];
    // dir may not exist yet on realpath; fall back to a non-resolved but validated path
    return [$type, $folder, data_web() . '/' . $type . '/' . $folder];
}

// ── One-shot migration of the dataset-type vocabulary ────────────────────────
//
// Releases before this one persisted two type words that no longer exist: 'fixed'
// (now '3d') and 'wholemount' (now '2d'). They went into the DATA_WEB and
// uploads/staging directory names, into the import journal file names AND their
// bodies, into every published metadata.json, into the per-dataset keys of
// api/stats.json, and into the operator's own documents under config/. Nothing
// reads the old words any more and there is no alias layer, so a deployment that
// already holds bytes is converted once, here.
//
// Idempotent, and it costs a handful of is_dir()/glob() calls plus two small file
// probes on a tree with nothing left to convert — which is what makes it
// affordable at the top of catalog.php, datasets.php and upload.php. There is no
// marker file: the guard below asks the tree itself, one question per artefact
// class, so a pass killed halfway (fatal, timeout, redeploy) is retried for
// exactly what is left rather than skipped forever.
//
// Renames go through a single @rename() whose failure is tolerated, so two requests
// arriving together cannot fight over the same directory: the loser simply finds
// the work already done.
//
// Step-for-step twin of dev_server.py:_migrate_dataset_types — SAME order, same
// guard, same collision rule. A deployment must convert identically whichever
// backend serves the first request after the update.

const LUMEN_LEGACY_TYPE_DIRS = ['fixed' => '3d', 'wholemount' => '2d'];

/** The former fifth type. A tracked timelapse was always written to DATA_WEB/live/ with
 *  tracks.json beside its bricks, so DATA_WEB/tracking/ only ever held what install.php
 *  seeded (an empty folder) or a hand-made dataset: removed when empty, reported when
 *  not — its bytes are never touched. Twin of dev_server._RETIRED_TYPE_DIR. */
const LUMEN_RETIRED_TYPE_DIR = 'tracking';

/** An explorer filter link as the page builder serialises it into config/pages/. */
const LUMEN_LEGACY_TYPE_HREF_RE = '/(explorer\.html\?type=)(fixed|wholemount)(?![A-Za-z0-9_-])/';
/** A link to the retired type's filter now opens the timelapses. */
const LUMEN_RETIRED_TYPE_HREF_RE = '/(explorer\.html\?type=)tracking(?![A-Za-z0-9_-])/';

/**
 * Substring probe on a small JSON file — cheaper than parsing it, and this runs on
 * a tree that usually has nothing left to migrate.
 *
 * Both slash spellings are tested because the two backends encode differently:
 * PHP's json_encode escapes '/' ("fixed\/Foo"), Python's json.dumps does not.
 */
function lumen_migration_file_has(string $path, array $needles): bool {
    if (!is_file($path)) return false;
    $raw = @file_get_contents($path);
    if (!is_string($raw) || $raw === '') return false;
    foreach ($needles as $n) if (strpos($raw, $n) !== false) return true;
    return false;
}

/** The guard: is there any artefact left in the old vocabulary? */
function lumen_migration_pending(): bool {
    $dw      = data_web();
    $staging = uploads_root() . '/staging';
    $state   = uploads_root() . '/state';
    foreach (LUMEN_LEGACY_TYPE_DIRS as $old => $canon) {
        if (is_dir("$dw/$old") || is_dir("$staging/$old")) return true;
        $journals = @glob("$state/{$old}__*.json");
        if (is_array($journals) && $journals) return true;
    }
    if (is_dir("$dw/" . LUMEN_RETIRED_TYPE_DIR) || is_dir("$staging/" . LUMEN_RETIRED_TYPE_DIR)) return true;
    if (lumen_migration_file_has(stats_file(), ['"fixed/', '"fixed\/', '"wholemount/', '"wholemount\/'])) return true;
    // "tracking": covers pageTitles.tracking and datasetTypes.tracking alike.
    if (lumen_migration_file_has(config_dir() . '/instance.json', ['"wholemount":', '"showTracking"', '"tracking":'])) return true;
    foreach ((array)@glob(config_dir() . '/pages/*.json') as $page) {
        // The full href pattern, not a bare substring: a page that merely mentions
        // "type=fixedish" must not keep this guard hot on every request.
        $raw = @file_get_contents($page);
        if (is_string($raw) && (preg_match(LUMEN_LEGACY_TYPE_HREF_RE, $raw) || preg_match(LUMEN_RETIRED_TYPE_HREF_RE, $raw))) return true;
    }
    return false;
}

/** The part of the guard the PUBLIC catalog needs: a legacy type directory still in
 *  DATA_WEB (the catalog scans the canonical names only). Two is_dir() calls. */
function lumen_migration_dirs_pending(): bool {
    foreach (array_keys(LUMEN_LEGACY_TYPE_DIRS) as $old) if (is_dir(data_web() . "/$old")) return true;
    return false;
}

/** Retire DATA_WEB/tracking and uploads/staging/tracking: gone when empty, reported —
 *  never moved, never deleted — when something is in them. */
function lumen_migration_retire_tracking(): void {
    foreach ([data_web() . '/' . LUMEN_RETIRED_TYPE_DIR, uploads_root() . '/staging/' . LUMEN_RETIRED_TYPE_DIR] as $root) {
        if (!is_dir($root)) continue;
        $names = @scandir($root);
        if (!is_array($names)) { error_log("dataset-type migration: FAILED to read $root"); continue; }
        $entries = array_values(array_filter($names, fn($n) => $n !== '.' && $n !== '..' && $n !== '.gitkeep'));
        if ($entries) {
            error_log("dataset-type migration: LEFT $root (" . count($entries) . " item(s)) - cell tracking is no longer a dataset type; a tracked timelapse belongs under DATA_WEB/live/");
            continue;
        }
        @unlink("$root/.gitkeep");
        if (!@rmdir($root)) error_log("dataset-type migration: FAILED to remove $root");
    }
}

/** '<legacyType>/<folder>' → '<canonicalType>/<folder>'. Anything else comes back untouched. */
function lumen_migrate_legacy_id($value) {
    if (!is_string($value)) return $value;
    $slash = strpos($value, '/');
    if ($slash === false) return $value;
    $head = substr($value, 0, $slash);
    if (!isset(LUMEN_LEGACY_TYPE_DIRS[$head])) return $value;
    return LUMEN_LEGACY_TYPE_DIRS[$head] . substr($value, $slash);
}

function lumen_migration_write_text(string $path, string $body): bool {
    return lumen_write_file_atomic($path, $body);
}

/**
 * Write a PUBLIC json document (metadata.json, config/*.json) through a temp sibling.
 * admin_write_json() is unusable here: it chmods 0600, which is right for api/ secrets
 * and would make a dataset's metadata unreadable by the web server.
 */
function lumen_migration_write_json(string $path, array $doc): bool {
    return lumen_migration_write_text($path, (string)json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

/**
 * Move a whole type directory onto its canonical name.
 *
 * A plain rename when the target does not exist; otherwise (a half-migrated tree, or
 * an operator who created the new folder by hand) the datasets are moved one by one
 * and a name that exists on BOTH sides is left alone and reported — never silently
 * overwritten, the bytes are irreplaceable.
 */
function lumen_migration_move_dir(string $src, string $dst): void {
    if (!is_dir($src)) return;
    if (!file_exists($dst) && @rename($src, $dst)) return;
    // Cross-device, or another process created the target between the two calls —
    // the per-child merge below handles both.
    if (!is_dir($dst) && !admin_make_dir($dst)) {
        error_log("dataset-type migration: cannot create $dst");
        return;
    }
    $names = @scandir($src);
    if (!is_array($names)) return;
    foreach ($names as $name) {
        if ($name === '.' || $name === '..') continue;
        if (file_exists("$dst/$name")) {
            error_log("dataset-type migration: SKIPPED $src/$name — $dst/$name already exists");
            continue;
        }
        if (!@rename("$src/$name", "$dst/$name")) {
            error_log("dataset-type migration: FAILED to move $src/$name");
        }
    }
    @rmdir($src);   // succeeds only once the directory is empty
}

/**
 * uploads/state/<type>__<folder>.json — the resumable-import journal.
 *
 * The type lives in the file NAME (lumen_up_list splits the stem) and again in the
 * document's `type` field, and the format is shared byte-for-byte with
 * upload_staging.py so an import started on one backend resumes on the other. Both
 * halves therefore move together.
 */
function lumen_migration_journals(): void {
    $state = uploads_root() . '/state';
    if (!is_dir($state)) return;
    foreach (LUMEN_LEGACY_TYPE_DIRS as $old => $canon) {
        foreach ((array)@glob("$state/{$old}__*.json") as $journal) {
            $target = $state . '/' . $canon . substr(basename($journal), strlen($old));
            if (file_exists($target)) {
                error_log("dataset-type migration: SKIPPED " . basename($journal) . " — " . basename($target) . " already exists");
                continue;
            }
            $doc = admin_read_json($journal);
            if (is_array($doc)) {
                $doc['type'] = $canon;
                // `files` is a MAP keyed by relative path in the shared format; an
                // empty PHP array would re-encode as `[]`, and upload_staging.py
                // resumes by iterating it as a dict.
                if (isset($doc['files']) && is_array($doc['files']) && !$doc['files']) $doc['files'] = new stdClass();
                if (!lumen_migration_write_text($target, (string)json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT))) {
                    error_log("dataset-type migration: FAILED journal " . basename($journal));
                    continue;
                }
                @unlink($journal);
            } elseif (!@rename($journal, $target)) {
                // Unreadable journal: moved as-is rather than dropped. Worst case the
                // operator re-drops the folder and the import re-plans.
                error_log("dataset-type migration: FAILED journal " . basename($journal));
                continue;
            }
            // The flock sidecar holds no state and is recreated on demand; an
            // in-flight writer keeps its own descriptor.
            @unlink($journal . '.lock');
        }
    }
}

function lumen_migration_has_legacy_ids($ids): bool {
    if (!is_array($ids)) return false;
    foreach ($ids as $v) if (lumen_migrate_legacy_id($v) !== $v) return true;
    return false;
}

/**
 * The editor's view of a staged dataset points its volume sources at the
 * session-gated blob proxy so the admin preview can mount bytes that are not web
 * served yet (lumen_staged_dataset). Written back into metadata.json, those URLs
 * survive publication and answer 401 to every visitor. Map any source addressed
 * through the proxy back onto the published DATA_WEB location; returns
 * [sources, changed]. Twin: upload_staging.py canonical_volume_sources.
 */
function lumen_canonical_volume_sources($sources, string $type, string $folder): array {
    if (!is_array($sources)) return [$sources, false];
    $base = "DATA_WEB/$type/$folder";
    $targets = ['path' => $base, 'manifestPath' => "$base/bricks/manifest.json"];
    $changed = false;
    foreach ($sources as $i => $src) {
        if (!is_array($src)) continue;
        foreach ($targets as $key => $value) {
            if (isset($src[$key]) && is_string($src[$key]) && strncmp($src[$key], 'api/upload.php', 14) === 0) {
                $sources[$i][$key] = $value;
                $changed = true;
            }
        }
    }
    return [$sources, $changed];
}

/**
 * Make every published metadata.json agree with its folder: `type` is the directory
 * it sits in, `id` is '<type>/<folder>', any dataset relation the operator recorded
 * is re-pointed at the new id, and no volume source is still addressed through the
 * staging proxy (an edit made during the import).
 */
function lumen_migration_metadata(): void {
    foreach (LUMEN_DATASET_TYPES as $type) {
        $base = data_web() . '/' . $type;
        $names = @scandir($base);
        if (!is_array($names)) continue;
        foreach ($names as $folder) {
            if ($folder === '.' || $folder === '..' || $folder === '' || $folder[0] === '.') continue;
            $path = "$base/$folder/metadata.json";
            if (!is_file($path)) continue;
            // Cheap read first: most files already agree, and those must cost no lock.
            $peek = admin_read_json($path);
            if ($peek === null) continue;
            if (($peek['type'] ?? null) === $type && ($peek['id'] ?? null) === "$type/$folder"
                && !lumen_migration_has_legacy_ids($peek['relatedIds'] ?? null)
                && !lumen_canonical_volume_sources($peek['volumeSources'] ?? null, $type, $folder)[1]) continue;
            lumen_with_lock($path, function () use ($path, $type, $folder) {
                $meta = lumen_read_json_doc($path);       // keeps `{}` maps as maps
                if ($meta === null) return;
                $meta['type'] = $type;                     // the folder is the authority
                $meta['id']   = "$type/$folder";
                if (isset($meta['relatedIds']) && is_array($meta['relatedIds'])) {
                    $meta['relatedIds'] = array_map('lumen_migrate_legacy_id', $meta['relatedIds']);
                }
                if (isset($meta['volumeSources'])) {
                    $meta['volumeSources'] = lumen_canonical_volume_sources($meta['volumeSources'], $type, $folder)[0];
                }
                if (!lumen_migration_write_json($path, $meta)) error_log("dataset-type migration: FAILED metadata $type/$folder");
            });
        }
    }
}

/** Two stats rows for one dataset (a legacy-keyed one and an already-canonical one):
 *  numeric counters add up, the most recent ISO timestamp wins. */
function lumen_migration_merge_counters($a, $b) {
    if (!is_array($a)) return $b;
    if (!is_array($b)) return $a;
    foreach ($b as $key => $value) {
        $current = $a[$key] ?? null;
        if (is_bool($value) || is_bool($current)) $a[$key] = $value;
        elseif ((is_int($value) || is_float($value)) && (is_int($current) || is_float($current))) $a[$key] = $current + $value;
        elseif (is_string($value) && is_string($current)) $a[$key] = max($current, $value);   // ISO sorts lexicographically
        elseif (!isset($a[$key])) $a[$key] = $value;
    }
    return $a;
}

/** api/stats.json is indexed by dataset id and is protected from updates, so a
 *  deployment's whole view/download history is keyed in the old vocabulary. */
function lumen_migration_stats(): void {
    $file = stats_file();
    if (!is_file($file)) return;
    lumen_with_lock($file, function () use ($file) {
        $d = admin_read_json($file);
        if (!is_array($d) || !isset($d['datasets']) || !is_array($d['datasets'])) return;
        $rekeyed = []; $changed = false;
        foreach ($d['datasets'] as $key => $value) {
            $new = lumen_migrate_legacy_id((string)$key);
            if ($new !== (string)$key) $changed = true;
            $rekeyed[$new] = isset($rekeyed[$new]) ? lumen_migration_merge_counters($rekeyed[$new], $value) : $value;
        }
        if (!$changed) return;
        $d['datasets'] = $rekeyed;
        admin_write_stats($d);
    });
}

/** Persist api/stats.json atomically. json_encode writes an empty PHP array as `[]`,
 *  and dev_server.py indexes `global`/`daily`/`datasets` as maps, so empty ones are
 *  re-objected. A failed write leaves the previous file whole. */
function admin_write_stats(array $d): bool {
    foreach (['global', 'daily', 'datasets'] as $k) {
        if (isset($d[$k]) && is_array($d[$k]) && !$d[$k]) $d[$k] = new stdClass();
    }
    $json = json_encode($d, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    return $json !== false && lumen_write_file_atomic(stats_file(), $json, 0600);
}

/** config/instance.json — pageTitles is keyed by <body data-page>, and the photograph
 *  page is served as 2d.html (data-page="2d"). The retired tracking page and type leave
 *  their title, their nav toggle and their display names. */
function lumen_migration_instance(): void {
    $file = config_dir() . '/instance.json';
    if (!is_file($file)) return;
    $doc = admin_read_json($file);
    if (!is_array($doc)) return;
    $changed = false;
    if (isset($doc['pageTitles']) && is_array($doc['pageTitles'])) {
        $titles = $doc['pageTitles'];
        if (array_key_exists('wholemount', $titles)) {
            // Never clobber a title the operator already set under the new key.
            if (!array_key_exists('2d', $titles)) $titles['2d'] = $titles['wholemount'];
            unset($titles['wholemount']);
            $changed = true;
        }
        if (array_key_exists('tracking', $titles)) { unset($titles['tracking']); $changed = true; }
        $doc['pageTitles'] = $titles;
    }
    if (isset($doc['nav']) && is_array($doc['nav']) && array_key_exists('showTracking', $doc['nav'])) {
        unset($doc['nav']['showTracking']);
        $changed = true;
    }
    if (isset($doc['datasetTypes']) && is_array($doc['datasetTypes']) && array_key_exists('tracking', $doc['datasetTypes'])) {
        unset($doc['datasetTypes']['tracking']);
        // json_encode writes an empty PHP array as `[]`; the client reads a map.
        if (!$doc['datasetTypes']) $doc['datasetTypes'] = new stdClass();
        $changed = true;
    }
    if (!$changed) return;
    if (!lumen_migration_write_json($file, $doc)) error_log('dataset-type migration: FAILED config/instance.json');
}

/** config/pages/<slug>.json holds operator-authored layouts whose buttons link to
 *  explorer.html?type=<type>. Those hrefs are content, so nothing else will ever fix
 *  them. Rewritten on the raw text so the operator's own formatting survives. */
function lumen_migration_pages(): void {
    foreach ((array)@glob(config_dir() . '/pages/*.json') as $page) {
        $raw = @file_get_contents($page);
        if (!is_string($raw) || $raw === '') continue;
        $next = preg_replace_callback(LUMEN_LEGACY_TYPE_HREF_RE,
            fn($m) => $m[1] . LUMEN_LEGACY_TYPE_DIRS[$m[2]], $raw);
        if (is_string($next)) $next = preg_replace(LUMEN_RETIRED_TYPE_HREF_RE, '${1}live', $next);
        if (!is_string($next) || $next === $raw) continue;
        if (!lumen_migration_write_text($page, $next)) error_log("dataset-type migration: FAILED " . basename($page));
    }
}

/** Convert a deployment to the canonical dataset vocabulary. At most once per
 *  request; a no-op on a host that has nothing left in the old words. */
function lumen_migrate_dataset_types(): void {
    static $ran = false;
    if ($ran) return;
    $ran = true;
    // The metadata pass is NOT gated on the legacy guard: every published
    // metadata.json must agree with its folder on `type` / `id`. A file that lost
    // them — this host wrote the editor's payload verbatim until v1.54.1, and the
    // editor never posts `type` — is put right on the first request that gets here,
    // without anyone re-saving it. One small read per dataset, as the catalog does.
    $pending = lumen_migration_pending();
    if ($pending) {
        $staging = uploads_root() . '/staging';
        foreach (LUMEN_LEGACY_TYPE_DIRS as $old => $canon) {
            lumen_migration_move_dir(data_web() . "/$old", data_web() . "/$canon");
            lumen_migration_move_dir("$staging/$old", "$staging/$canon");
        }
        lumen_migration_retire_tracking();
        lumen_migration_journals();
    }
    lumen_migration_metadata();
    if ($pending) {
        lumen_migration_stats();
        lumen_migration_instance();
        lumen_migration_pages();
    }
}

// ── Public catalog ───────────────────────────────────────────────────────────
// Twin of dev_server.py _list_datasets + _build_catalog, field for field: a
// dataset's entry IS its metadata.json, with the identity and the derived fields
// re-asserted from the directory; listed when configured OR thumbnailed, never when
// hidden; newest `date` first, then by name, both descending. A fixed key list here
// used to drop every field the client later started reading (date, markers,
// fileSize…) on PHP hosts only, and list half-configured datasets Python hid.

/** Python truthiness of a decoded JSON value (None/False/0/""/[]/{} are false). */
function lumen_py_truthy($v): bool {
    if ($v instanceof stdClass) return (bool)get_object_vars($v);
    return !($v === null || $v === false || $v === 0 || $v === 0.0 || $v === '' || $v === []);
}

/** One dataset row, or null when the folder holds no readable metadata.json object. */
function lumen_catalog_row(string $type, string $name, string $ds_dir): ?array {
    $raw = @file_get_contents($ds_dir . DIRECTORY_SEPARATOR . 'metadata.json');
    if (!is_string($raw)) return null;
    $meta = lumen_json_decode_doc($raw);
    if ($meta instanceof stdClass) $meta = [];
    if (!is_array($meta) || ($meta && array_keys($meta) === range(0, count($meta) - 1))) return null;

    $id = $type . '/' . $name;
    $configured = $meta['configured'] ?? false;
    if (!lumen_py_truthy($configured)) $configured = $meta['_adminConfigured'] ?? false;
    $entry = $meta;
    $entry['id']           = $id;
    $entry['path']         = $id;
    $entry['name']         = lumen_py_truthy($meta['name'] ?? null) ? $meta['name'] : $name;
    $entry['folderName']   = $name;
    $entry['type']         = $type;
    $entry['stage']        = $meta['stage'] ?? null;
    $entry['stageNumeric'] = $meta['stageNumeric'] ?? null;
    $entry['embryo']       = $meta['embryo'] ?? null;
    $entry['configured']   = $configured;
    $entry['thumbnail']    = is_file($ds_dir . DIRECTORY_SEPARATOR . 'thumbnail.webp')
        ? 'DATA_WEB/' . $id . '/thumbnail.webp' : null;
    if (!array_key_exists('volumeSources', $entry)) {
        // A 2d dataset is a photograph: nothing for the volume renderer to mount.
        $entry['volumeSources'] = $type === '2d' ? [] : [[
            'kind' => 'webstack', 'label' => 'Web slice stack', 'priority' => 0,
            'available' => true, 'multiscale' => false, 'path' => 'DATA_WEB/' . $id,
        ]];
    }
    return $entry;
}

/** Every dataset with a metadata.json, in directory order (types, then folder names). */
function lumen_catalog_rows(): array {
    $rows = [];
    foreach (LUMEN_DATASET_TYPES as $type) {
        $type_dir = data_web() . DIRECTORY_SEPARATOR . $type;
        if (!is_dir($type_dir)) continue;
        $names = @scandir($type_dir) ?: [];
        foreach ($names as $name) {
            if ($name === '' || $name[0] === '.') continue;
            $ds_dir = $type_dir . DIRECTORY_SEPARATOR . $name;
            if (!is_dir($ds_dir)) continue;
            $row = lumen_catalog_row($type, $name, $ds_dir);
            if ($row !== null) $rows[] = $row;
        }
    }
    return $rows;
}

/** The public catalog: a JSON list, the same document dev_server.py serves. */
function rebuild_catalog(): array {
    $catalog = array_values(array_filter(lumen_catalog_rows(), fn($ds) =>
        (lumen_py_truthy($ds['configured'] ?? null) || ($ds['thumbnail'] ?? null) !== null)
        && !lumen_py_truthy($ds['hidden'] ?? null)));
    // Every missing/'Unknown' date collapses to one sentinel so it sorts last.
    $dateKey = fn(array $x) => (is_string($x['date'] ?? null) && $x['date'] !== '' && $x['date'] !== 'Unknown')
        ? $x['date'] : '0000-00-00';
    $nameKey = fn(array $x) => is_scalar($x['name'] ?? null) ? (string)$x['name'] : '';
    usort($catalog, function ($a, $b) use ($dateKey, $nameKey) {
        $c = strcmp($dateKey($b), $dateKey($a));
        return $c !== 0 ? $c : strcmp($nameKey($b), $nameKey($a));
    });
    return $catalog;
}

/**
 * What the catalog depends on, read with stat calls only: every type directory, and
 * per dataset its folder (a thumbnail or a sub-folder appearing changes it) and its
 * metadata.json. mtimes have a one-second resolution, so the size is part of it, and
 * every write through this API also drops the cache outright (lumen_catalog_invalidate).
 */
function lumen_catalog_signature(): string {
    clearstatcache();
    $parts = [];
    foreach (LUMEN_DATASET_TYPES as $type) {
        $type_dir = data_web() . DIRECTORY_SEPARATOR . $type;
        if (!is_dir($type_dir)) { $parts[] = "$type:-"; continue; }
        $parts[] = $type . ':' . (int)@filemtime($type_dir);
        foreach (@scandir($type_dir) ?: [] as $name) {
            if ($name === '' || $name[0] === '.') continue;
            $ds = $type_dir . DIRECTORY_SEPARATOR . $name;
            $m  = $ds . DIRECTORY_SEPARATOR . 'metadata.json';
            $st = @stat($m);
            $parts[] = $name . ':' . (int)@filemtime($ds) . ':' . ($st ? $st['mtime'] . '.' . $st['size'] : '-');
        }
    }
    return hash('sha256', implode('|', $parts));
}

function lumen_catalog_cache_file(): string { return admin_private_dir() . '/.catalog-cache.json'; }

function lumen_catalog_invalidate(): void {
    $f = lumen_catalog_cache_file();
    if (is_file($f)) @unlink($f);
}

/** The catalog response body, rebuilt only when the signature moved. */
function lumen_catalog_json(): string {
    $sig = lumen_catalog_signature();
    $cache = admin_read_json(lumen_catalog_cache_file());
    if (is_array($cache) && ($cache['sig'] ?? null) === $sig && is_string($cache['body'] ?? null)) {
        return $cache['body'];
    }
    $body = json_encode(rebuild_catalog(), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body === false) {
        $body = (string)json_encode(rebuild_catalog(),
            JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }
    $doc = json_encode(['sig' => $sig, 'body' => $body], JSON_UNESCAPED_SLASHES);
    if ($doc !== false) lumen_write_file_atomic(lumen_catalog_cache_file(), $doc, 0600);
    return $body;
}

// ── Directory guards (.htaccess written at runtime) ───────────────────────────
// DATA_WEB is in the updater's protect list and uploads/ + config/uploads/ are
// created at runtime, so an update can never deliver their rules: the platform
// writes them itself. Every directive sits inside an <IfModule> guard — a module the
// host has not loaded must not turn every request under the tree into a 500 — and
// none uses `Options`, which needs AllowOverride Options (a 500 on hosts that only
// allow FileInfo/AuthConfig); directory listings are refused by the root .htaccess
// rewrite instead.
//
// A guard is (re)written only when the file lacks the current marker, so the two
// backends (upload_staging.py writes the same files) and the copy shipped in the
// repository do not keep rewriting one another over whitespace.
const LUMEN_GUARD_MARKER = 'lumen-guard v2';

/** The script-execution ban shared by every operator-writable, web-served tree. */
function lumen_exec_ban_rules(): string {
    return "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n"
         . "<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n"
         . "<IfModule mod_php5.c>\n    php_flag engine off\n</IfModule>\n"
         . "<FilesMatch \"\\.(php|php[0-9]|phtml|phps|phar|cgi|pl|py|sh|shtml|htaccess)\$\">\n"
         . "    <IfModule mod_authz_core.c>\n        Require all denied\n    </IfModule>\n"
         . "    <IfModule !mod_authz_core.c>\n        Order allow,deny\n        Deny from all\n    </IfModule>\n"
         . "</FilesMatch>\n"
         . "<IfModule mod_mime.c>\n    RemoveHandler .php .phtml .phar .cgi .pl .py .sh .shtml\n"
         . "    RemoveType .php .phtml .phar\n</IfModule>\n";
}

/** DATA_WEB/.htaccess: execution ban, no MIME sniffing, and every file under a
 *  dataset's download/ folder served as an attachment — an operator-supplied file
 *  (an XML or HTML report dropped there by SFTP) must never render as a document of
 *  this origin. */
function lumen_data_web_guard(): string {
    return "# Lumen3D — published dataset tree (" . LUMEN_GUARD_MARKER . "). Generated by the\n"
         . "# platform (api/_upload_lib.php, upload_staging.py); keep the copy in the\n"
         . "# repository (DATA_WEB/.htaccess) identical.\n"
         . lumen_exec_ban_rules()
         . "<IfModule mod_headers.c>\n"
         . "    Header set X-Content-Type-Options \"nosniff\"\n"
         . "    <IfModule mod_setenvif.c>\n"
         . "        SetEnvIf Request_URI \"/download/\" LUMEN_DOWNLOAD=1\n"
         . "        Header set Content-Disposition \"attachment\" env=LUMEN_DOWNLOAD\n"
         . "    </IfModule>\n"
         . "</IfModule>\n";
}

/** uploads/.htaccess: nothing in the staging store is ever reachable at a URL. */
function lumen_staging_guard(): string {
    return "# Lumen3D upload staging (" . LUMEN_GUARD_MARKER . ") — bytes here have NOT been\n"
         . "# validated yet and must never be reachable at a URL. The admin preview reads\n"
         . "# them through the authenticated api/upload.php?action=blob proxy instead.\n"
         . "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n"
         . "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n"
         . "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n"
         . "<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n";
}

/** config/uploads/.htaccess (media library): images only, never a script. */
function lumen_media_guard(): string {
    return "# Lumen3D media library (" . LUMEN_GUARD_MARKER . "). Generated by api/media.php.\n"
         . lumen_exec_ban_rules()
         . "<IfModule mod_headers.c>\n    Header set X-Content-Type-Options \"nosniff\"\n</IfModule>\n";
}

/** Write $body to $path when the directory exists and the file lacks the marker. */
function lumen_write_guard(string $path, string $body): void {
    if (!is_dir(dirname($path))) return;
    $cur = is_file($path) ? @file_get_contents($path) : false;
    if (is_string($cur) && strpos($cur, LUMEN_GUARD_MARKER) !== false) return;
    lumen_write_file_atomic($path, $body);
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

// ── Telemetry throttle (twin: dev_server.py _telemetry_allow — read the format and
// the arithmetic there) ──────────────────────────────────────────────────────
// One fixed-size binary file (16-byte global bucket + LUMEN_TELEMETRY_SLOTS 16-byte
// slots, u32 tag | u32 milli-tokens | u64 last refill ms, little-endian): it can
// never grow, and a request costs a lock and two 16-byte reads/writes. It sits in a
// dot-directory under api/, which every host shape refuses to serve.
const LUMEN_TELEMETRY_IP_BURST = 60;
const LUMEN_TELEMETRY_IP_RATE = 1;
const LUMEN_TELEMETRY_GLOBAL_BURST = 600;
const LUMEN_TELEMETRY_GLOBAL_RATE = 20;
const LUMEN_TELEMETRY_SLOTS = 4096;

function lumen_telemetry_store(): ?string {
    $dir = admin_private_dir() . '/.telemetry';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) return null;
    return $dir . '/throttle.bin';
}

function lumen_telemetry_refill(int $tokens, int $last, int $now, int $burst, int $rate): array {
    if ($now > $last) $tokens = min($burst * 1000, $tokens + ($now - $last) * $rate);
    return [$tokens, $now];
}

/** Spend one token of the client's bucket and of the global one, or refuse. A store
 *  that cannot be opened lets the beacon through: counting is the beacon's job. */
function lumen_telemetry_allow(string $ip, ?int $nowMs = null, ?string $store = null): bool {
    $now = $nowMs ?? (int)floor(microtime(true) * 1000);
    $path = $store ?? lumen_telemetry_store();
    if ($path === null) return true;
    $fh = @fopen($path, 'c+b');
    if ($fh === false) return true;
    if (!@flock($fh, LOCK_EX)) { @fclose($fh); return true; }
    try {
        $h = hash('sha256', $ip !== '' ? $ip : 'unknown', true);
        $slot = unpack('V', substr($h, 0, 4))[1] % LUMEN_TELEMETRY_SLOTS;
        $tag = unpack('V', substr($h, 4, 4))[1] | 1;
        $off = 16 * (1 + $slot);
        $read = function (int $at) use ($fh): array {
            fseek($fh, $at);
            $raw = (string)fread($fh, 16);
            if (strlen($raw) !== 16) return [0, 0, 0];
            $u = unpack('Vtag/Vtok/Pt', $raw);
            return [$u['tag'], $u['tok'], $u['t']];
        };
        [, $gTok, $gT] = $read(0);
        if ($gT === 0) { $gTok = LUMEN_TELEMETRY_GLOBAL_BURST * 1000; $gT = $now; }
        [$gTok, $gT] = lumen_telemetry_refill($gTok, $gT, $now, LUMEN_TELEMETRY_GLOBAL_BURST, LUMEN_TELEMETRY_GLOBAL_RATE);
        [$sTag, $sTok, $sT] = $read($off);
        if ($sTag !== $tag) { $sTag = $tag; $sTok = LUMEN_TELEMETRY_IP_BURST * 1000; $sT = $now; }
        [$sTok, $sT] = lumen_telemetry_refill($sTok, $sT, $now, LUMEN_TELEMETRY_IP_BURST, LUMEN_TELEMETRY_IP_RATE);
        $allowed = $sTok >= 1000 && $gTok >= 1000;
        if ($allowed) { $sTok -= 1000; $gTok -= 1000; }
        fseek($fh, 0);
        fwrite($fh, pack('VVP', 0, $gTok, $gT));
        fseek($fh, $off);
        fwrite($fh, pack('VVP', $sTag, $sTok, $sT));
        return $allowed;
    } finally {
        @flock($fh, LOCK_UN);
        @fclose($fh);
    }
}

function admin_record_event(string $kind, ?string $datasetId = null): void {
    $map = ['visit' => 'visits', 'view' => 'views', 'download' => 'downloads'];
    if (!isset($map[$kind])) return;
    $field = $map[$kind];
    $today = date('Y-m-d');
    // Read-modify-write under a lock; the file is replaced atomically, so a full disk
    // or a killed request can no longer truncate the whole usage history to nothing.
    lumen_with_lock(stats_file(), function () use ($kind, $field, $today, $datasetId) {
        $d = admin_read_json(stats_file()) ?? [];
        $d['global']   = is_array($d['global'] ?? null) ? $d['global'] : ['visits' => 0, 'views' => 0, 'downloads' => 0, 'since' => date('c')];
        $d['daily']    = is_array($d['daily'] ?? null) ? $d['daily'] : [];
        $d['datasets'] = is_array($d['datasets'] ?? null) ? $d['datasets'] : [];
        $d['global'][$field] = (int)($d['global'][$field] ?? 0) + 1;
        $d['daily'][$today][$field] = (int)($d['daily'][$today][$field] ?? 0) + 1;
        if ($datasetId && in_array($kind, ['view', 'download'], true)) {
            $d['datasets'][$datasetId][$field] = (int)($d['datasets'][$datasetId][$field] ?? 0) + 1;
            if ($kind === 'view') $d['datasets'][$datasetId]['lastViewed'] = date('c');
        }
        admin_write_stats($d);
    });
}

/**
 * Count a download of DATA_WEB/<type>/<folder>/download/<file> (twin of
 * dev_server.py _maybe_count_download). Counted: a full GET of a file that exists,
 * inside the download/ folder of a dataset that exists. Not counted: a HEAD, a
 * Range continuation (one download = one increment), anything else. Returns the
 * dataset id counted, null when nothing was. Called by api/download.php (Apache,
 * reached through the root .htaccess) and router.php (php -S).
 */
function lumen_count_download(string $rel, string $method, bool $hasRange): ?string {
    if (strtoupper($method) !== 'GET' || $hasRange) return null;
    $rel = ltrim(str_replace('\\', '/', $rel), '/');
    if (!preg_match('#^DATA_WEB/([^/]+)/([^/]+)/download/(.+)$#iD', $rel, $m)) return null;
    foreach (explode('/', $m[3]) as $seg) {
        if ($seg === '' || $seg === '.' || $seg === '..') return null;
    }
    // The type directory may be spelt in any case on a case-insensitive filesystem;
    // the stats key may not (same key as the telemetry beacon and the Python twin).
    $safe = admin_safe_dataset(strtolower($m[1]) . '/' . $m[2]);
    if ($safe === null || !is_dir($safe[2])) return null;
    $root = realpath($safe[2] . '/download');
    $file = $root !== false ? realpath($root . '/' . $m[3]) : false;
    if ($root === false || $file === false || strpos($file, $root . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) return null;
    $id = $safe[0] . '/' . $safe[1];
    try { admin_record_event('download', $id); } catch (\Throwable $e) { return null; }
    return $id;
}

// ── Plugins ─────────────────────────────────────────────────────────────────
function admin_list_plugins(): array {
    $plugins = [];
    foreach (['tools', 'channels', 'shaders'] as $placement) {
        $base = modules_dir() . '/' . $placement;
        if (!is_dir($base)) continue;
        foreach (scandir($base) as $name) {
            if ($name[0] === '.' || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $name)) continue;
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

// ── Release notes ────────────────────────────────────────────────────────────
// The notes of every version ship as ONE asset of each release
// (tools/build_release.py → lumen3d-release-notes.json): a host that skipped
// releases shows the notes of every version it is about to absorb without one
// GitHub call per version — and a version that was never tagged has no release
// body anywhere else. Twins of dev_server.py _select_changelogs /
// _release_notes_bundle / _local_changelogs.
const RELEASE_NOTES_ASSET = 'lumen3d-release-notes.json';
const RELEASE_NOTES_MAX_BYTES = 4 * 1024 * 1024;

/** The notes of every version the host will absorb — current < v <= latest —
 *  oldest first, so the operator reads them in the order they were released. */
function admin_select_changelogs(array $versions, string $current, string $latest): array {
    $lo = admin_version_tuple($current !== '' ? $current : '0.0.0');
    $hi = admin_version_tuple($latest !== '' ? $latest : '0.0.0');
    $picked = [];
    foreach ($versions as $v => $md) {
        if (!is_string($v) || !is_string($md) || trim($md) === '' || !preg_match('/^\d+\.\d+\.\d+$/', $v)) continue;
        $tv = admin_version_tuple($v);
        if ($tv > $lo && $tv <= $hi) $picked[] = ['t' => $tv, 'version' => $v, 'markdown' => $md];
    }
    usort($picked, fn($a, $b) => $a['t'] <=> $b['t']);
    return array_map(fn($p) => ['version' => $p['version'], 'markdown' => $p['markdown']], $picked);
}

function admin_parse_release_notes_bundle(string $raw): array {
    $doc = json_decode($raw, true);
    $out = [];
    foreach ((is_array($doc) ? ($doc['versions'] ?? []) : []) as $e) {
        if (is_array($e) && is_string($e['version'] ?? null) && is_string($e['markdown'] ?? null)) {
            $out[$e['version']] = $e['markdown'];
        }
    }
    return $out;
}

/** {version: markdown} from the release's notes asset, or null when the release
 *  predates the asset (its body then stands for the latest version alone). PHP has
 *  no process to remember the download in, so it is cached in a file under api/
 *  (never served), keyed by tag — the asset of a tag never changes. */
function admin_release_notes_bundle(array $rel): ?array {
    $tag = (string)($rel['tag_name'] ?? '');
    $url = null; $size = null;
    foreach (($rel['assets'] ?? []) as $a) {
        if (($a['name'] ?? '') === RELEASE_NOTES_ASSET) {
            $url = (string)($a['browser_download_url'] ?? '');
            $size = $a['size'] ?? null;
            break;
        }
    }
    if (!$url || $tag === '') return null;
    if (is_int($size) && $size > RELEASE_NOTES_MAX_BYTES) return null;
    $cachePath = __DIR__ . '/release-notes-cache.json';
    $cached = admin_read_json($cachePath);
    if (is_array($cached) && ($cached['tag'] ?? null) === $tag && is_array($cached['versions'] ?? null)) {
        return $cached['versions'];
    }
    $raw = mkt_fetch_bytes($url, RELEASE_NOTES_MAX_BYTES);
    if ($raw === null) return null;
    $bundle = admin_parse_release_notes_bundle($raw);
    if ($bundle) admin_write_json($cachePath, ['tag' => $tag, 'fetchedAt' => date('c'), 'versions' => $bundle]);
    return $bundle ?: null;
}

/** The notes of every installed version, newest first — what the changelog page
 *  lists under the pending ones. */
function admin_local_changelogs(): array {
    $out = [];
    foreach ((array)@glob(changelog_dir() . '/changelog_*.md') as $p) {
        if (!preg_match('/changelog_(\d+\.\d+\.\d+)\.md$/', basename((string)$p), $m)) continue;
        $md = @file_get_contents((string)$p);
        if (!is_string($md) || trim($md) === '') continue;
        $out[] = ['t' => admin_version_tuple($m[1]), 'version' => $m[1], 'markdown' => $md];
    }
    usort($out, fn($a, $b) => $b['t'] <=> $a['t']);
    return array_map(fn($p) => ['version' => $p['version'], 'markdown' => $p['markdown']], $out);
}

/** Twin of dev_server.py:_preprocess_version — the version of the Python
 *  preprocessing pipeline the operator can actually obtain. The downloadable pack
 *  wins: on a PHP host it is the only copy present (the release ships no
 *  preprocess/ sources), so its own VERSION.json is the truthful answer. */
function admin_preprocess_version(): ?string {
    $v = admin_pipeline_pack_versions()['preprocess'] ?? null;
    if ($v) return (string)$v;
    $f = admin_root() . '/preprocess/run_preprocess.py';
    if (is_file($f)) {
        $txt = @file_get_contents($f);
        if ($txt && preg_match('/__version__\s*=\s*["\']([\d.]+)["\']/', $txt, $m)) return $m[1];
    }
    return admin_max_version(admin_root() . '/preprocess/changelog');
}

// ── Downloadable processing pipelines (twin of dev_server.py:_pipeline_*) ─────
// The admin panel offers a self-contained pack (Imaris .ims volume pipeline +
// Imaris-Excel tracking pipeline + worked examples + a self-verifying launcher).
// The light edition ships inside the release under assets/pipeline/; the complete
// edition carries a ~72 MB Python runtime and is fetched by the operator's browser
// straight from the GitHub release, never proxied through this host — mkt_fetch_bytes
// buffers whole bodies in memory and caps far below that size.
const PIPELINE_EDITIONS = [
    'leger'   => 'lumen3d-pipeline-leger-',
    'complet' => 'lumen3d-pipeline-complet-',
];

function admin_pipeline_dir(): string { return admin_root() . '/assets/pipeline'; }

/** The VERSION.json a pack carries (twin of dev_server.py:_pipeline_pack_doc).
 *  Static-cached on (path, mtime, size): PHP is per-request, but a single admin
 *  request opens the same archive more than once. */
function admin_pipeline_pack_doc(string $pack): array {
    static $cache = [];
    $key = $pack . '|' . (int)@filemtime($pack) . '|' . (int)@filesize($pack);
    if (isset($cache[$key])) return $cache[$key];
    $doc = [];
    if (class_exists('ZipArchive')) {
        $zip = new ZipArchive();
        if ($zip->open($pack) === true) {
            $raw = false;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $n = $zip->statIndex($i)['name'] ?? '';
                if ($n === 'VERSION.json' || substr($n, -13) === '/VERSION.json') {
                    $raw = $zip->getFromIndex($i);
                    break;
                }
            }
            $zip->close();
            $parsed = is_string($raw) ? json_decode($raw, true) : null;
            if (is_array($parsed)) $doc = $parsed;
        }
    }
    $cache[$key] = $doc;
    return $doc;
}

/** The pack to serve for an edition — the current one when several coexist (twin
 *  of dev_server.py:_pipeline_local).
 *
 *  They do coexist precisely HERE: admin_update_apply_php copies a release over
 *  the tree without removing what the previous one left behind. The filename
 *  cannot arbitrate, because since web v1.42.0 a pack is named after the PIPELINE
 *  version it contains, which does not move in step with the platform version — a
 *  pack named 0.15.0 supersedes one named 1.41.0. So the pack declaring THIS
 *  install's platform version wins, then the most recently written one, then the
 *  highest version in the name. */
function admin_pipeline_local(string $edition): ?string {
    $prefix = PIPELINE_EDITIONS[$edition] ?? null;
    if ($prefix === null) return null;
    $dir = admin_pipeline_dir();
    if (!is_dir($dir)) return null;
    $found = glob($dir . '/' . $prefix . '*.zip') ?: [];
    if (!$found) return null;
    if (count($found) === 1) return $found[0];

    $here = admin_max_version(changelog_dir());
    $best = null; $bestRank = null;
    foreach ($found as $path) {
        $declared = admin_pipeline_pack_doc($path)['platformVersion'] ?? null;
        $matches = $here !== null && $declared === $here;
        $rank = [$matches ? 1 : 0, (int)@filemtime($path), admin_version_tuple(basename($path, '.zip'))];
        if ($bestRank === null || $rank > $bestRank) { $bestRank = $rank; $best = $path; }
    }
    return $best;
}

/** Versions carried BY the local pack (twin of dev_server.py:_pipeline_pack_versions).
 *  The pack's own version is the pipeline's; the platform version recorded beside
 *  it is what lets admin_pipeline_local tell a current pack from a leftover. */
function admin_pipeline_pack_versions(): array {
    $pack = admin_pipeline_local('leger') ?? admin_pipeline_local('complet');
    if ($pack === null) return [];
    $doc = admin_pipeline_pack_doc($pack);
    return [
        'pack'       => $doc['bundleVersion'] ?? null,
        'preprocess' => $doc['preprocessVersion'] ?? null,
        'platform'   => $doc['platformVersion'] ?? null,
    ];
}

/** The pipeline packs attached to the latest release, per edition (twin of
 *  dev_server.py:_pipeline_remote_assets).
 *
 *  A pack is named after the PIPELINE version it contains, so the filename alone
 *  dates it — nothing has to be downloaded to tell whether this host's copy is
 *  behind. Static-cached: PHP is per-request, but one admin request asks twice
 *  (the download card and the update check) and GitHub allows 60 calls an hour. */
function admin_pipeline_remote_assets(): array {
    static $cache = null;
    if ($cache !== null) return $cache;

    $raw = mkt_fetch_bytes('https://api.github.com/repos/' . GITHUB_REPO . '/releases/latest', 512 * 1024);
    if ($raw === null) {
        return $cache = ['reason' => 'unreachable', 'detail' => mkt_last_error(), 'editions' => []];
    }
    $rel = json_decode($raw, true);
    if (!is_array($rel)) return $cache = ['reason' => 'unreachable', 'editions' => []];

    $out = ['tag' => $rel['tag_name'] ?? null, 'editions' => []];
    foreach (($rel['assets'] ?? []) as $asset) {
        $name = $asset['name'] ?? '';
        if (substr($name, -4) !== '.zip') continue;
        foreach (PIPELINE_EDITIONS as $edition => $prefix) {
            if (strncmp($name, $prefix, strlen($prefix)) !== 0) continue;
            $out['editions'][$edition] = [
                'available' => true,
                'name'      => $name,
                'size'      => $asset['size'] ?? null,
                'url'       => $asset['browser_download_url'] ?? null,
                'tag'       => $rel['tag_name'] ?? null,
                'version'   => admin_version_name($name),
            ];
        }
    }
    return $cache = $out;
}

function admin_version_name(string $stem): ?string {
    return preg_match('/(\d+\.\d+\.\d+)/', $stem, $m) ? $m[1] : null;
}

function admin_pipeline_github_asset(): array {
    $remote = admin_pipeline_remote_assets();
    if (isset($remote['editions']['complet'])) return $remote['editions']['complet'];
    if (isset($remote['reason'])) {
        return ['available' => false, 'reason' => $remote['reason'],
                'detail' => $remote['detail'] ?? null];
    }
    return ['available' => false, 'reason' => 'absent', 'tag' => $remote['tag'] ?? null];
}

/** Pipeline version a local pack contains — declared inside, filename as fallback. */
function admin_pipeline_local_version(string $pack): ?string {
    return admin_pipeline_pack_doc($pack)['bundleVersion'] ?? admin_version_name(basename($pack, '.zip'));
}

/** Whether a newer pipeline pack than this host's has been published (twin of
 *  dev_server.py:_pipeline_update_state).
 *
 *  The pack has its own release cadence — the preprocessing tool moves on its own
 *  numbers, and a platform update is not what should carry it. So the host's copy
 *  is compared against what the latest release attaches, and each edition that is
 *  behind gets the newer pack offered next to the one already here. */
function admin_pipeline_update_state(array &$info, ?array $remote = null): array {
    $remote = $remote ?? admin_pipeline_remote_assets();
    $editions = $remote['editions'] ?? [];
    if (!$editions) {
        return ['available' => false, 'reason' => $remote['reason'] ?? 'absent',
                'detail' => $remote['detail'] ?? null, 'tag' => $remote['tag'] ?? null];
    }

    $newestLocal = null; $newestRemote = null;
    foreach (array_keys(PIPELINE_EDITIONS) as $edition) {
        $here = $info[$edition] ?? [];
        $there = $editions[$edition] ?? null;
        // Only a LOCAL pack can be behind: an edition served straight from GitHub is
        // by construction the published one.
        if (($here['source'] ?? null) !== 'local' || $there === null) continue;
        $localV = $here['version'] ?? null; $remoteV = $there['version'] ?? null;
        if (!$localV || !$remoteV) continue;
        if (admin_version_tuple($remoteV) <= admin_version_tuple($localV)) continue;
        $info[$edition]['newer'] = $there;
        if ($newestLocal === null || admin_version_tuple($localV) < admin_version_tuple($newestLocal)) {
            $newestLocal = $localV;
        }
        if ($newestRemote === null || admin_version_tuple($remoteV) > admin_version_tuple($newestRemote)) {
            $newestRemote = $remoteV;
        }
    }

    return ['available' => $newestRemote !== null, 'local' => $newestLocal,
            'remote' => $newestRemote, 'tag' => $remote['tag'] ?? null];
}

// ── Document library (twin of dev_server.py _docs_list / _doc_fetch) ──────────
// Operator documents live in DOCS/ on GitHub, not in the release, so a corrected
// guide reaches every install without shipping a new platform version. The
// filename carries the metadata:
//
//     260803 - GUIDE-ADMIN - FR.pdf
//     ^date    ^stable id    ^language
//
// Anything that does not match the rule is listed as skipped rather than guessed at.
const DOCS_DIR_REMOTE = 'DOCS';
// Read from the published branch, not from wherever development happens.
const DOCS_BRANCH     = 'main';
const DOCS_CACHE_TTL  = 600;              // GitHub allows 60 unauthenticated calls/hour

function admin_doc_parse(string $name): ?array {
    if (!preg_match('/^(\d{6})\s*-\s*(.+?)\s*-\s*([A-Za-z]{2,6})\.([A-Za-z0-9]{1,5})$/', $name, $m)) {
        return null;
    }
    [$all, $stamp, $id, $lang, $ext] = $m;
    $y = 2000 + (int)substr($stamp, 0, 2);
    $mo = (int)substr($stamp, 2, 2);
    $d  = (int)substr($stamp, 4, 2);
    if (!checkdate($mo, $d, $y)) return null;   // 260899 is not a date
    return [
        'file' => $name, 'stamp' => $stamp,
        'date' => sprintf('%04d-%02d-%02d', $y, $mo, $d),
        'id' => trim($id), 'lang' => strtoupper($lang), 'ext' => strtolower($ext),
    ];
}

function docs_cache_file(): string { return api_dir() . '/docs-cache.json'; }

function admin_docs_list(bool $force = false): array {
    $cf = docs_cache_file();
    if (!$force && is_file($cf) && (time() - (int)@filemtime($cf)) < DOCS_CACHE_TTL) {
        $c = json_decode((string)@file_get_contents($cf), true);
        if (is_array($c)) return $c;
    }

    $raw = mkt_fetch_bytes('https://api.github.com/repos/' . GITHUB_REPO
                           . '/contents/' . DOCS_DIR_REMOTE . '?ref=' . DOCS_BRANCH, 1024 * 1024);
    if ($raw === null) {
        $le = mkt_last_error();
        $payload = ['docs' => [], 'repo' => GITHUB_REPO,
                    'error' => (($le['status'] ?? 0) === 403) ? 'rate_limited'
                             : (!empty($le['ca']) ? 'tls_ca_broken' : 'unreachable'),
                    'detail' => (string)($le['curl'] ?: $le['stream'])];
        @file_put_contents($cf, json_encode($payload));
        return $payload;
    }
    $entries = json_decode($raw, true);
    if (!is_array($entries) || !isset($entries[0])) {
        $payload = ['docs' => [], 'repo' => GITHUB_REPO, 'error' => 'no_folder'];
        @file_put_contents($cf, json_encode($payload));
        return $payload;
    }

    $groups = []; $skipped = [];
    foreach ($entries as $e) {
        if (($e['type'] ?? '') !== 'file') continue;
        $nm = (string)($e['name'] ?? '');
        $info = admin_doc_parse($nm);
        if ($info === null) {
            // README.md documents the naming rule and belongs here; flagging it as
            // malformed on every listing is just noise.
            $low = strtolower($nm);
            if (strpos($low, 'readme') !== 0 && strpos($low, '.') !== 0) $skipped[] = $nm;
            continue;
        }
        $info['size'] = (int)($e['size'] ?? 0);
        $groups[$info['id']]['id'] = $info['id'];
        $groups[$info['id']]['versions'][] = $info;
    }

    $docs = [];
    foreach ($groups as $g) {
        usort($g['versions'], function ($a, $b) {
            return [$b['stamp'], $b['lang']] <=> [$a['stamp'], $a['lang']];
        });
        $langs = array_values(array_unique(array_column($g['versions'], 'lang')));
        sort($langs);
        $g['languages']  = $langs;
        $g['latest']     = $g['versions'][0]['stamp'];
        $g['latestDate'] = $g['versions'][0]['date'];
        $docs[] = $g;
    }
    usort($docs, function ($a, $b) { return [$b['latest'], $b['id']] <=> [$a['latest'], $a['id']]; });

    $payload = ['docs' => $docs, 'repo' => GITHUB_REPO, 'folder' => DOCS_DIR_REMOTE,
                'skipped' => array_slice($skipped, 0, 10)];
    @file_put_contents($cf, json_encode($payload));
    @chmod($cf, 0644);
    return $payload;
}

function admin_doc_mime(string $ext): string {
    static $m = [
        'pdf' => 'application/pdf', 'md' => 'text/plain; charset=utf-8',
        'txt' => 'text/plain; charset=utf-8', 'html' => 'text/html; charset=utf-8',
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'svg' => 'image/svg+xml', 'zip' => 'application/zip',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    return $m[$ext] ?? 'application/octet-stream';
}

// Only these may be shown in a frame. HTML and SVG are deliberately absent: both
// can carry script, and a document is fetched from a repository — displaying one
// inline on this origin would run it beside the admin session. They download.
const DOC_INLINE_OK = ['pdf', 'png', 'jpg', 'jpeg', 'txt', 'md'];

function admin_doc_send(string $name, bool $inline): void {
    // Validated against the naming rule AND the live listing: the proxy must never
    // be usable to pull an arbitrary repo path through an admin session.
    $info = admin_doc_parse($name);
    $listing = admin_docs_list();
    $known = [];
    foreach ($listing['docs'] ?? [] as $d) {
        foreach ($d['versions'] as $v) $known[$v['file']] = true;
    }
    if ($info === null || !isset($known[$name])) {
        admin_json_out(['error' => 'unknown_document'], 404);
    }
    $url = 'https://raw.githubusercontent.com/' . GITHUB_REPO . '/' . DOCS_BRANCH . '/'
         . DOCS_DIR_REMOTE . '/' . rawurlencode($name);
    $body = mkt_fetch_bytes($url, 64 * 1024 * 1024);
    if ($body === null) {
        admin_json_out(['error' => 'fetch_failed'], 502);
    }
    // Proxied rather than linked: raw.github serves octet-stream (the browser would
    // download instead of display) and a cross-origin frame is refused by the CSP.
    header('Content-Type: ' . admin_doc_mime($info['ext']));
    header('Content-Length: ' . strlen($body));
    $inline = $inline && in_array($info['ext'], DOC_INLINE_OK, true);
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment')
           . '; filename="' . str_replace('"', '', $name) . '"');
    header('Cache-Control: private, max-age=300');
    echo $body;
    exit;
}

function admin_pipeline_info(): array {
    // No build-on-demand twin: a PHP host has neither preprocess/ nor SCRIPTS/ nor
    // tools/ (none are in the release allowlist), so the shipped zip is all there is.
    $lite = admin_pipeline_local('leger');
    $full = admin_pipeline_local('complet');

    // "preprocess" IS the pack's version (CLAUDE.md §1.5: the pack is the
    // preprocessing tool) and is what its filename now carries; "platform" is the
    // web release it was built alongside, absent from packs predating that.
    $info = [
        'versions' => [
            'web'        => admin_max_version(changelog_dir()),
            'preprocess' => admin_preprocess_version(),
            'platform'   => admin_pipeline_pack_versions()['platform'] ?? null,
        ],
        'leger'   => ['available' => false],
        'complet' => ['available' => false],
    ];
    if ($lite !== null) {
        $info['leger'] = ['available' => true, 'name' => basename($lite),
                          'size' => filesize($lite), 'source' => 'local',
                          'version' => admin_pipeline_local_version($lite)];
    }
    if ($full !== null) {
        $info['complet'] = ['available' => true, 'name' => basename($full),
                            'size' => filesize($full), 'source' => 'local',
                            'version' => admin_pipeline_local_version($full)];
    } else {
        $remote = admin_pipeline_github_asset();
        $remote['source'] = 'github';
        $info['complet'] = $remote;
    }

    $info['update'] = admin_pipeline_update_state($info);
    return $info;
}

function admin_pipeline_send(string $edition) {
    $path = admin_pipeline_local($edition);
    if ($path === null || !is_file($path)) {
        admin_json_out(['error' => 'pipeline_unavailable', 'edition' => $edition], 404);
    }
    // Any output buffering started upstream would be prepended to the zip bytes and
    // corrupt the archive, so every layer is discarded before the body is emitted.
    while (ob_get_level() > 0) { ob_end_clean(); }
    header('Content-Type: application/zip');
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: attachment; filename="' . basename($path) . '"');
    header('Cache-Control: no-store');
    @set_time_limit(0);
    readfile($path);
    exit;
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

/** {relpath: sha256hex} over raw bytes for every identity-bearing file.
 *  $cached reuses a digest while the file's (mtime, ctime, size) is unchanged — for
 *  the PUBLIC discovery path, which runs on every page load. Safe because the client
 *  re-hashes the exact bytes it executes against the vouched hash (a stale digest
 *  fails closed there); approval and installation always hash fresh. */
function admin_plugin_file_hashes(string $modDir, bool $cached = false): array {
    $out = [];
    if (!is_dir($modDir)) return $out;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($modDir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (!$f->isFile()) continue;
        $ext = strtolower($f->getExtension());
        if (!in_array($ext, TRUST_HASH_EXT, true) || $f->getFilename()[0] === '.') continue;
        $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($modDir) + 1));
        $out[$rel] = $cached ? admin_cached_file_hash($f->getPathname()) : hash_file('sha256', $f->getPathname());
    }
    ksort($out);
    return $out;
}

/** sha256 of a file, memoised in api/.plugin-hash-cache.json on (mtime, ctime, size). */
function admin_cached_file_hash(string $path) {
    static $cache = null, $dirty = false;
    $file = admin_private_dir() . '/.plugin-hash-cache.json';
    if ($cache === null) {
        $cache = admin_read_json($file) ?? [];
        register_shutdown_function(function () use (&$cache, &$dirty, $file) {
            if (!$dirty) return;
            // Bounded: entries for files that no longer exist are dropped on save.
            foreach (array_keys($cache) as $k) if (!is_file((string)$k)) unset($cache[$k]);
            $json = json_encode($cache ?: new stdClass(), JSON_UNESCAPED_SLASHES);
            if ($json !== false) lumen_write_file_atomic($file, $json, 0600);
        });
    }
    $st = @stat($path);
    if ($st === false) return hash_file('sha256', $path);
    $sig = $st['mtime'] . ':' . $st['ctime'] . ':' . $st['size'];
    $hit = $cache[$path] ?? null;
    if (is_array($hit) && ($hit[0] ?? null) === $sig && is_string($hit[1] ?? null)) return $hit[1];
    $h = hash_file('sha256', $path);
    if (is_string($h)) { $cache[$path] = [$sig, $h]; $dirty = true; }
    return $h;
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

/** Dev-trust: every unapproved plugin of a .git checkout runs — so it is granted only
 *  when the operator says so explicitly (environment LUMEN_DEV_TRUST=1, e.g. SetEnv in
 *  a development vhost or `LUMEN_DEV_TRUST=1 php -S …`). The client address cannot
 *  decide it: behind a reverse proxy on the same machine EVERY visitor arrives from
 *  127.0.0.1. Single source of truth so the classifier and the plugin_trust endpoint
 *  report the same value. */
function admin_dev_trust(): bool {
    $flag = getenv('LUMEN_DEV_TRUST');
    if (!is_string($flag) || $flag === '') $flag = (string)($_SERVER['LUMEN_DEV_TRUST'] ?? '');
    return $flag === '1' && is_dir(admin_root() . '/.git');
}

function admin_classify_plugin(string $pluginPath, string $modDir, array $approvals, ?array $manifest, bool $cachedHashes = false): array {
    $fh = admin_plugin_file_hashes($modDir, $cachedHashes);
    $hash = admin_plugin_hash($fh);
    $base = ['hash' => $hash, 'files' => array_keys($fh)];
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

// ── CA trust store repair (twin of install.php's ca_* helpers) ────────────────
// Shared hosts sometimes ship a php.ini whose curl.cainfo / openssl.cafile names
// a bundle that was never installed (e.g. /usr/share/php/cacert.pem). cURL then
// aborts BEFORE opening the socket ("error setting certificate file: …") and the
// stream wrapper fails verification for the same reason — every marketplace and
// update fetch looks like an outage. We hand the transport a real bundle instead.
// Peer verification is NEVER disabled.

/** @return array{0:?string,1:?string} [cafile, capath]; [null,null] = none found. */
function admin_ca_probe(): array {
    static $cached = null;
    if ($cached !== null) return $cached;
    $files = [
        admin_root() . '/cacert.pem',              // operator override (web root)
        '/etc/ssl/certs/ca-certificates.crt',      // Debian / Ubuntu
        '/etc/pki/tls/certs/ca-bundle.crt',        // RHEL / CentOS / Fedora
        '/etc/ssl/ca-bundle.pem',                  // SUSE
        '/etc/pki/tls/cacert.pem',
        '/etc/ssl/cert.pem',                       // Alpine / BSD / macOS
        '/usr/local/share/certs/ca-root-nss.crt',  // FreeBSD
        '/usr/local/etc/openssl/cert.pem',
        // Last resort: the Mozilla bundle SHIPPED WITH THE RELEASE. It refreshes with
        // every update and cannot be deleted by accident (unlike an operator-uploaded
        // cacert.pem), so a host with no usable system store still works out of the box.
        __DIR__ . '/ca-bundle.pem',
        admin_root() . '/.lumen-ca-seed.pem',      // written by install.php on such a host
    ];
    foreach ($files as $f) if (@is_readable($f)) return $cached = [$f, null];
    foreach (['/etc/ssl/certs', '/etc/pki/tls/certs'] as $d) if (@is_dir($d)) return $cached = [null, $d];
    return $cached = [null, null];
}

function admin_ca_ini_broken(): bool {
    foreach (['curl.cainfo', 'openssl.cafile'] as $k) {
        $v = (string)ini_get($k);
        if ($v !== '' && !@is_readable($v)) return true;
    }
    return false;
}

function admin_ca_curl_opts(bool $force = false): array {
    if (!$force && !admin_ca_ini_broken()) return [];
    [$file, $dir] = admin_ca_probe();
    $o = [];
    if ($file !== null) $o[CURLOPT_CAINFO] = $file;
    elseif ($dir !== null) $o[CURLOPT_CAPATH] = $dir;
    return $o;
}

function admin_ca_stream_opts(bool $force = false): array {
    $ssl = ['verify_peer' => true, 'verify_peer_name' => true];
    if (!$force && !admin_ca_ini_broken()) return $ssl;
    [$file, $dir] = admin_ca_probe();
    if ($file !== null) $ssl['cafile'] = $file;
    elseif ($dir !== null) $ssl['capath'] = $dir;
    return $ssl;
}

function admin_is_ca_error(string $err): bool {
    if ($err === '') return false;
    $e = strtolower($err);
    foreach (['certificate file', 'cacert', 'ca cert', 'trust anchor', 'local issuer', 'certificate verify failed',
              'unable to get issuer', 'ssl ca', 'self signed certificate in certificate chain'] as $needle) {
        if (strpos($e, $needle) !== false) return true;
    }
    return false;
}

function mkt_fetch_bytes(string $url, int $limit): ?string {
    // Prefer cURL (enabled on most shared hosts even when allow_url_fopen is OFF —
    // matching install.php's http_get_small); fall back to the stream wrapper only
    // when allow_url_fopen is available. A host with neither returns null. The write
    // callback caps the body at $limit+1 bytes so an oversized response can't balloon
    // memory (a truncated body then fails the signature check — fail-closed).
    $caError = false;
    mkt_last_error(['status' => 0, 'curl' => '', 'stream' => '', 'ca' => false, 'headers' => []]);
    if (function_exists('curl_init')) {
        $body = mkt_curl_fetch($url, $limit, admin_ca_curl_opts(), $caError);
        if ($body === null && $caError) {                                    // broken trust store, not an outage
            $forced = admin_ca_curl_opts(true);
            if ($forced !== []) $body = mkt_curl_fetch($url, $limit, $forced, $caError);
        }
        if ($body !== null) return $body;
    }
    if (filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
        $ctx = stream_context_create([
            'http' => ['timeout' => 60, 'header' => "User-Agent: lumen3d-admin\r\n"],
            'ssl'  => admin_ca_stream_opts($caError),
        ]);
        $d = @file_get_contents($url, false, $ctx, 0, $limit + 1);
        // $http_response_header exists here whenever a response was actually received
        // (even a 4xx). A status means the transport WORKED, so it outranks the cURL
        // leg's diagnosis — otherwise a 403 rate limit on a host with a broken
        // curl.cainfo would be reported as a certificate problem.
        $status = 0; $hdrs = [];
        if (isset($http_response_header) && is_array($http_response_header)) {
            foreach ($http_response_header as $line) {
                if (stripos($line, 'HTTP/') === 0) {
                    if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) { $status = (int)$m[1]; $hdrs = []; }
                } elseif (strpos($line, ':') !== false) {
                    [$k, $v] = explode(':', $line, 2);
                    $hdrs[strtolower(trim($k))] = trim($v);
                }
            }
        }
        if ($d !== false) return substr($d, 0, $limit);
        $prev = mkt_last_error();
        if ($status > 0) {
            mkt_last_error(['status' => $status, 'headers' => $hdrs]);
        } elseif ($prev['status'] === 0 && $prev['curl'] === '') {
            $e = error_get_last();
            mkt_last_error(['stream' => $e['message'] ?? 'stream fetch failed']);
        }
    }
    return null;
}

/**
 * Why the last mkt_fetch_bytes() failed. Without this the admin UI could only say
 * "unreachable", which sends the operator looking for a firewall when the real
 * cause is a GitHub rate limit or a broken CA store.
 * @return array{status:int,curl:string,stream:string,ca:bool,headers:array<string,string>}
 */
function mkt_last_error(?array $set = null): array {
    static $last = ['status' => 0, 'curl' => '', 'stream' => '', 'ca' => false, 'headers' => []];
    if ($set !== null) $last = $set + ['status' => 0, 'curl' => '', 'stream' => '', 'ca' => false, 'headers' => []];
    return $last;
}

/** Map the recorded failure to an error code + detail for the admin UI. */
function mkt_error_payload(): array {
    $e = mkt_last_error();
    $status = (int)$e['status'];
    $h = $e['headers'];
    $rateLimited = ($status === 403 || $status === 429)
        && (($h['x-ratelimit-remaining'] ?? null) === '0' || isset($h['retry-after']));
    if ($rateLimited) {
        $min = null;
        if (isset($h['x-ratelimit-reset'])) $min = max(1, (int)ceil(((int)$h['x-ratelimit-reset'] - time()) / 60));
        elseif (isset($h['retry-after']))   $min = max(1, (int)ceil((int)$h['retry-after'] / 60));
        return ['error' => 'rate_limited', 'retryAfterMin' => $min, 'detail' => 'HTTP ' . $status];
    }
    if ($e['ca'])          return ['error' => 'tls_ca_broken', 'detail' => $e['curl'] ?: 'CA store unusable'];
    if ($status >= 400)    return ['error' => 'unreachable', 'detail' => 'HTTP ' . $status];
    if ($e['curl'] !== '') return ['error' => 'unreachable', 'detail' => $e['curl']];
    if ($e['stream'] !== '') return ['error' => 'unreachable', 'detail' => $e['stream']];
    return ['error' => 'unreachable', 'detail' => 'no HTTP transport available'];
}

/**
 * Download $url straight into $dest (at most $limit bytes), never holding the body
 * in memory: a release zip buffered whole could exceed a shared host's 128 MB
 * memory_limit. Same transports and CA repair as mkt_fetch_bytes. False (and no
 * $dest) on any failure; mkt_last_error() says why.
 */
function mkt_fetch_to_file(string $url, string $dest, int $limit): bool {
    $caError = false;
    mkt_last_error(['status' => 0, 'curl' => '', 'stream' => '', 'ca' => false, 'headers' => []]);
    if (function_exists('curl_init')) {
        if (mkt_curl_to_file($url, $dest, $limit, admin_ca_curl_opts(), $caError)) return true;
        if ($caError) {
            $forced = admin_ca_curl_opts(true);
            if ($forced !== [] && mkt_curl_to_file($url, $dest, $limit, $forced, $caError)) return true;
        }
    }
    if (!filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) return false;
    $ctx = stream_context_create([
        'http' => ['timeout' => 120, 'header' => "User-Agent: lumen3d-admin\r\n"],
        'ssl'  => admin_ca_stream_opts($caError),
    ]);
    $in = @fopen($url, 'rb', false, $ctx);
    if ($in === false) { $e = error_get_last(); mkt_last_error(['stream' => $e['message'] ?? 'stream fetch failed']); return false; }
    $out = @fopen($dest, 'wb');
    if ($out === false) { fclose($in); return false; }
    $n = 0; $ok = true;
    while (!feof($in)) {
        $block = fread($in, 1048576);
        if ($block === false) { $ok = false; break; }
        $n += strlen($block);
        if ($n > $limit || @fwrite($out, $block) !== strlen($block)) { $ok = false; break; }
    }
    fclose($in); fclose($out);
    if (!$ok || $n === 0) { @unlink($dest); mkt_last_error(['stream' => $n > $limit ? 'body over limit' : 'stream read failed']); return false; }
    return true;
}

/** One cURL attempt of mkt_fetch_to_file. */
function mkt_curl_to_file(string $url, string $dest, int $limit, array $caOpts, bool &$caError): bool {
    $fp = @fopen($dest, 'wb');
    if ($fp === false) return false;
    $n = 0; $over = false; $short = false;
    $ch = curl_init($url);
    curl_setopt_array($ch, $caOpts + [
        CURLOPT_FOLLOWLOCATION  => true,
        CURLOPT_MAXREDIRS       => 5,
        CURLOPT_PROTOCOLS       => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT  => 20,
        CURLOPT_TIMEOUT         => 600,
        CURLOPT_SSL_VERIFYPEER  => true,
        CURLOPT_SSL_VERIFYHOST  => 2,
        CURLOPT_USERAGENT       => 'lumen3d-admin',
        CURLOPT_WRITEFUNCTION   => function ($c, $chunk) use ($fp, &$n, $limit, &$over, &$short) {
            $n += strlen($chunk);
            if ($n > $limit) { $over = true; return 0; }                   // 0 aborts the transfer
            if (fwrite($fp, $chunk) !== strlen($chunk)) { $short = true; return 0; }
            return strlen($chunk);
        },
    ]);
    curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = (string)curl_error($ch);
    $caError = admin_is_ca_error($err);
    curl_close($ch);
    fclose($fp);
    if (!$over && !$short && $err === '' && $code >= 200 && $code < 300 && $n > 0) return true;
    @unlink($dest);
    mkt_last_error(['status' => $code, 'curl' => $over ? 'body over limit' : ($short ? 'disk write failed' : $err), 'ca' => $caError]);
    return false;
}

/** One cURL attempt. Sets $caError when the failure is a trust-store problem. */
function mkt_curl_fetch(string $url, int $limit, array $caOpts, bool &$caError): ?string {
    $buf = ''; $headers = [];
    $ch = curl_init($url);
    curl_setopt_array($ch, $caOpts + [
        CURLOPT_HEADERFUNCTION  => function ($c, $line) use (&$headers) {
            if (strpos($line, ':') !== false) {
                [$k, $v] = explode(':', $line, 2);
                $headers[strtolower(trim($k))] = trim($v);                   // rate-limit headers live here
            }
            return strlen($line);
        },
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
    $err  = (string)curl_error($ch);
    $caError = admin_is_ca_error($err);
    curl_close($ch);
    if ($buf !== '' && $code >= 200 && $code < 300) return substr($buf, 0, $limit);
    mkt_last_error(['status' => $code, 'curl' => $err, 'ca' => $caError, 'headers' => $headers]);
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
    if ($raw === null) return [false, 'catalog_fetch_failed: ' . (mkt_error_payload()['detail'] ?? '?')];
    if (!mkt_verify_signature($raw, MARKETPLACE_CATALOG_URL . '.sig')) return [false, 'catalog_signature_invalid'];
    $d = json_decode($raw, true);
    if (!is_array($d) || !isset($d['plugins']) || !is_array($d['plugins'])) return [false, 'invalid_catalog'];
    $refusal = mkt_check_serial($d);
    if ($refusal !== null) return [false, $refusal];
    return [true, $d['plugins']];
}

// Anti-rollback (twin of dev_server.py _marketplace_check_serial — the rationale is
// there): the highest signed-catalog `serial` this host accepted lives in
// api/marketplace-state.json; an older catalog is refused. Only a signature-proven
// catalog may raise it.
function mkt_state_file(): string { return __DIR__ . '/marketplace-state.json'; }

/** null when the catalog may be used, else the error code. The last refusal's
 *  serials are kept in mkt_rollback_info() for the listing. */
function mkt_check_serial(array $doc): ?string {
    $serial = $doc['serial'] ?? 0;
    if (!is_int($serial) || $serial < 0) return 'catalog_invalid_serial';
    if (MARKETPLACE_PUBKEY === '') return null;
    $out = lumen_with_lock(mkt_state_file(), function () use ($serial, $doc) {
        $state = admin_read_json(mkt_state_file());
        $seen = is_array($state) && is_int($state['highestSerial'] ?? null) && $state['highestSerial'] >= 0
            ? $state['highestSerial'] : 0;
        if ($serial < $seen) { mkt_rollback_info(['offered' => $serial, 'seen' => $seen]); return 'catalog_rollback'; }
        if ($serial > $seen) {
            $issued = $doc['issuedAt'] ?? null;
            lumen_write_file_atomic(mkt_state_file(), (string)json_encode([
                'highestSerial' => $serial,
                'issuedAt' => is_string($issued) ? $issued : null,
                'acceptedAt' => date('Y-m-d\TH:i:s'),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        }
        return null;
    });
    return is_string($out) ? $out : null;
}

function mkt_rollback_info(?array $set = null): ?array {
    static $info = null;
    if ($set !== null) $info = $set;
    return $info;
}

function mkt_list(): array {
    $base = ['configured' => MARKETPLACE_CATALOG_URL !== '', 'signed' => MARKETPLACE_PUBKEY !== ''];
    if (MARKETPLACE_CATALOG_URL === '') return $base + ['plugins' => []];
    [$ok, $res] = mkt_fetch_catalog();
    if (!$ok) {
        $out = $base + ['error' => $res, 'plugins' => []];
        if ($res === 'catalog_rollback') $out['rollback'] = mkt_rollback_info();
        return $out;
    }
    $ver = admin_max_version(changelog_dir());
    $installed = [];
    foreach (admin_list_plugins() as $p) $installed[$p['path']] = $p;
    $out = [];
    foreach ($res as $e) {
        if (!is_array($e)) continue;
        $pid = (string)($e['id'] ?? '');
        $placement = $e['placement'] ?? null;
        $path = in_array($placement, ['tools', 'channels', 'shaders'], true) ? "$placement/$pid" : null;
        [$c, $cr] = admin_compat_satisfies($ver, $e['platformCompat'] ?? null);
        $local = ($path !== null && isset($installed[$path])) ? $installed[$path] : null;
        $cur = ($local && !empty($local['version'])) ? (string)$local['version'] : null;
        $latest = !empty($e['latestVersion']) ? (string)$e['latestVersion'] : null;
        // No version on either side ⇒ nothing to compare ⇒ no update offered.
        $newer = ($cur !== null && $latest !== null
                  && admin_version_tuple($latest) > admin_version_tuple($cur));
        $out[] = [
            'id' => $pid, 'name' => $e['name'] ?? $pid, 'placement' => $placement, 'subtype' => $e['subtype'] ?? null,
            'description' => $e['description'] ?? null, 'creator' => $e['creator'] ?? null, 'icon' => $e['icon'] ?? null,
            'platformCompat' => $e['platformCompat'] ?? null, 'sandboxCapabilities' => $e['sandboxCapabilities'] ?? null,
            'latestVersion' => $latest, 'recommended' => $e['recommended'] ?? false,
            'installed' => $local !== null, 'installedVersion' => $cur,
            // Split in two: what the Updates tab may act on, and what it must still
            // show with a reason (a newer version this platform cannot accept).
            'updateAvailable' => $newer && $c, 'updateBlocked' => $newer && !$c,
            'compat' => $c, 'compatReason' => $cr,
        ];
    }
    return $base + ['plugins' => $out];
}

function mkt_rmrf(string $p): void {
    if (is_dir($p) && !is_link($p)) { foreach (scandir($p) as $c) { if ($c !== '.' && $c !== '..') mkt_rmrf("$p/$c"); } @rmdir($p); }
    elseif (is_file($p) || is_link($p)) @unlink($p);
}

/** A plugin package entry the platform can host: browser assets only, never a
 *  server-side script or a dotfile (.htaccess, .user.ini). */
function mkt_plugin_entry_allowed(string $name): bool {
    $base = basename($name);
    if ($base === '' || $base[0] === '.') return false;
    if (strpos($base, '.') === false) return true;                 // LICENSE, README
    $ext = strtolower((string)pathinfo($base, PATHINFO_EXTENSION));
    return in_array($ext, ['js', 'mjs', 'json', 'css', 'html', 'md', 'txt', 'png', 'jpg', 'jpeg', 'gif',
                           'webp', 'svg', 'woff', 'woff2', 'ttf', 'otf', 'wasm', 'glsl', 'frag', 'vert', 'map'], true);
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
        // js/modules/ is served as static files with no execution ban: a plugin
        // package may only carry what a browser plugin is made of.
        if (substr($name, -1) !== '/' && !mkt_plugin_entry_allowed($name)) { $zip->close(); return null; }
        $total += (int)$st['size'];
        if ($total > 24 * 1024 * 1024) { $zip->close(); return null; }
    }
    admin_make_dir($dest);
    $zip->extractTo($dest);
    $zip->close();
    if (is_file("$dest/plugin.json")) return $dest;
    $subs = array_values(array_filter(glob("$dest/*") ?: [], 'is_dir'));
    if (count($subs) === 1 && is_file($subs[0] . '/plugin.json')) return $subs[0];
    return null;
}

/** Install — or with $upgrade, replace in place — a catalog plugin. On ANY failure
 *  js/modules is left as it was found, which for an upgrade means the working
 *  version is restored rather than the operator losing the plugin.
 *  @return array{0:int,1:array} [httpStatus, payload] */
function mkt_install(string $catalogId, string $password, bool $upgrade = false): array {
    if (MARKETPLACE_CATALOG_URL === '') return [400, ['error' => 'marketplace_not_configured']];
    if (!admin_reauth($password)) return [401, ['error' => 'bad_password']];
    $rec = admin_credential();
    [$ok, $res] = mkt_fetch_catalog();
    if (!$ok) return [502, $res === 'catalog_rollback' ? ['error' => $res, 'rollback' => mkt_rollback_info()] : ['error' => $res]];
    $entry = null;
    foreach ($res as $e) { if (is_array($e) && (string)($e['id'] ?? '') === $catalogId) { $entry = $e; break; } }
    if (!$entry) return [404, ['error' => 'unknown_catalog_id']];
    $placement = $entry['placement'] ?? ''; $pid = (string)($entry['id'] ?? '');
    if (!in_array($placement, ['tools', 'channels', 'shaders'], true) || !preg_match('/^[A-Za-z0-9_][A-Za-z0-9._-]*$/D', $pid)) return [400, ['error' => 'bad_plugin_id']];
    $path = "$placement/$pid"; $targetDir = modules_dir() . "/$placement/$pid";
    if (is_dir($targetDir) && !$upgrade) return [409, ['error' => 'already_installed']];
    if ($upgrade && !is_dir($targetDir)) return [404, ['error' => 'not_installed']];
    [$c, $cr] = admin_compat_satisfies(admin_max_version(changelog_dir()), $entry['platformCompat'] ?? null);
    if (!$c) return [409, ['error' => 'incompatible', 'detail' => $cr]];
    $assetUrl = $entry['assetUrl'] ?? null; $sumsUrl = $entry['sumsUrl'] ?? null; $sigUrl = $entry['sigUrl'] ?? null;
    if (!$assetUrl) return [400, ['error' => 'no_asset']];
    // Extract UNDER the modules dir (same filesystem as the final target). The final
    // step is an atomic rename() into js/modules/<placement>/<id>; if the temp lived in
    // sys_get_temp_dir() (/tmp), that rename fails with EXDEV on the MANY shared hosts
    // where /tmp is a different mount than the web root — silently leaving an empty
    // placement folder and no installed plugin. Keeping the temp on the same volume
    // makes the rename same-filesystem (matches the Python twin's tempfile.mkdtemp(dir=MODULES_DIR)).
    $modBase = modules_dir();
    if (!admin_make_dir($modBase)) return [500, ['error' => 'install_failed', 'detail' => 'modules_dir']];
    $tmp = $modBase . '/.mkt-' . bin2hex(random_bytes(6));
    admin_make_dir($tmp);
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
    admin_make_dir(dirname($targetDir));
    // Park the working copy instead of deleting it: the rename below can still
    // fail, and an operator who asked for an upgrade must never end up with less
    // than they had.
    $backup = null;
    if (is_dir($targetDir)) {
        $backup = "$tmp/previous";
        if (!@rename($targetDir, $backup)) { mkt_rmrf($tmp); return [502, ['error' => 'install_failed', 'detail' => 'park']]; }
    }
    if (!@rename($proot, $targetDir)) {
        if ($backup !== null) @rename($backup, $targetDir);
        mkt_rmrf($tmp);
        return [502, ['error' => 'install_failed', 'detail' => 'move']];
    }
    mkt_modes_recursive($targetDir);                       // zip extraction ignores our modes
    mkt_rmrf($tmp);                                        // takes the parked previous version with it
    $serverHash = admin_plugin_hash(admin_plugin_file_hashes($targetDir));
    $declared = admin_plugin_declared_caps($targetDir);
    $wantsSandbox = (($meta['sandbox'] ?? null) === true) || ($placement === 'tools' && !empty($declared));
    $mode = $wantsSandbox ? 'sandboxed' : 'trusted';
    $approvals = array_values(array_filter(admin_load_trust(), fn($a) => ($a['path'] ?? '') !== $path));
    $approvals[] = ['path' => $path, 'sha256' => $serverHash, 'mode' => $mode, 'caps' => array_values($declared), 'at' => date('c'), 'by' => $rec['username'] ?? 'admin'];
    admin_save_trust($approvals);
    return [200, ['ok' => true, 'path' => $path, 'mode' => $mode,
                  'version' => $meta['version'] ?? null, 'upgraded' => $upgrade]];
}

/** @return array{0:int,1:array} */
function mkt_uninstall(string $path): array {
    if (!preg_match('#^(tools|channels|shaders)/[A-Za-z0-9_][A-Za-z0-9._-]*$#D', $path)) return [400, ['error' => 'bad_path']];
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

// ── Platform self-update (PHP hosts) ────────────────────────────────────────
// The Python server self-updates via a Blue-Green staging swap because it must
// restart a long-lived process. PHP is per-request (nothing to restart), so an
// update is just: download the release zip → verify (sha256 + optional Ed25519,
// fail-closed when keyed) → staged extract UNDER the web root (same volume, no
// EXDEV) → move files into place, skipping operator state. Synchronous — the
// admin UI gets the outcome in the update_apply response itself.

/** Pinned Ed25519 release publisher key (hex, 32 bytes). Twin of
 *  dev_server.py:_RELEASE_PUBKEY_HEX / install.php:$PINNED_PUBKEY. Empty ⇒
 *  sha256-only (the sums file itself is unauthenticated); set ⇒ signature
 *  verification is MANDATORY and failures abort the update. */
const LUMEN_RELEASE_PUBKEY = '9635e20bd09e2dc84830b018a99f3fb051de2f44db97f03e8d5f28e8d769ed79';

/** Paths an update must never overwrite (twin of dev_server._UPDATE_PROTECT,
 *  restricted to what can exist on a PHP host) + Python/dev files that have no
 *  business on a PHP deployment (twin of install.php:is_php_host_skip). */
function admin_update_protected(string $rel): bool {
    static $phpHostSkip = ['dev_server.py', 'fast_server.py', 'ed25519_pure.py', 'start.bat'];
    if (in_array($rel, $phpHostSkip, true)) return true;
    // Operator-edited config: protect only once it exists (a fresh file from the
    // release is fine on first install; an update must not clobber the operator's).
    static $protectExisting = ['config/instance.json', 'config/theme.json', 'config/theme.css', 'config/legal.json'];
    if (in_array($rel, $protectExisting, true)) return is_file(admin_root() . '/' . $rel);
    // Runtime/operator state — never shipped in a release, but fail-safe anyway.
    static $stateFiles = ['api/admin_credential.json', 'api/config.json', 'api/stats.json',
                          'api/disabled-plugins.json', 'api/quarantined-plugins.json', 'api/plugin-trust.json',
                          'api/.update-pending.json', 'api/trusted-proxies.json', 'api/marketplace-state.json'];
    if (in_array($rel, $stateFiles, true)) return true;
    foreach (['config/pages/', 'api/page-drafts/', 'secrets/',
              'DATA_WEB/', 'logs/', 'backups/', 'js/modules/'] as $prefix) {
        if (strpos($rel, $prefix) === 0) return true;
    }
    return false;
}

/** Files earlier releases shipped that no release carries any more: removed by the
 *  update (api/config.php held the bcrypt hash of the old documented default
 *  password, as text, readable wherever its deny rule is not honoured). */
const ADMIN_UPDATE_OBSOLETE = ['api/config.php'];

// ── Root .htaccess: shipped rules + the operator's own lines ─────────────────
// Shared hosts routinely need lines of their own in the root .htaccess (AddHandler
// for a PHP version, RewriteBase, php_value…). An update replacing the file
// wholesale dropped them — after which PHP could be served as text and the admin
// that ran the update 500s. The shipped rules sit between BEGIN/END LUMEN3D
// markers; everything outside them belongs to the operator and is kept.
const LUMEN_HTACCESS_BEGIN = '# BEGIN LUMEN3D';
const LUMEN_HTACCESS_END   = '# END LUMEN3D';

/** The shipped block (markers included); the whole file when it has no markers. */
function admin_htaccess_block(string $shipped): string {
    $b = strpos($shipped, LUMEN_HTACCESS_BEGIN);
    $e = strpos($shipped, LUMEN_HTACCESS_END);
    if ($b === false || $e === false || $e < $b) {
        return LUMEN_HTACCESS_BEGIN . "\n" . rtrim($shipped, "\r\n") . "\n" . LUMEN_HTACCESS_END . "\n";
    }
    return substr($shipped, $b, $e + strlen(LUMEN_HTACCESS_END) - $b) . "\n";
}

/**
 * Merge a newly shipped root .htaccess into the one on disk.
 *  - The file on disk has markers: what is outside them is kept verbatim, what is
 *    inside is replaced by the shipped block.
 *  - It has none (written before the markers existed, or by the host): its
 *    top-level host directives that the shipped file does not already carry are
 *    kept in an operator section ABOVE the block (so an AddHandler still decides
 *    which PHP runs the rewrites below it); everything else was ours.
 */
function admin_merge_htaccess(string $existing, string $shipped): string {
    $block = admin_htaccess_block($shipped);
    $existing = str_replace("\r\n", "\n", $existing);
    $b = strpos($existing, LUMEN_HTACCESS_BEGIN);
    $e = strpos($existing, LUMEN_HTACCESS_END);
    if ($b !== false && $e !== false && $e > $b) {
        $after = substr($existing, $e + strlen(LUMEN_HTACCESS_END));
        return substr($existing, 0, $b) . $block . ltrim($after, "\n");
    }
    $shippedLines = array_map('trim', explode("\n", str_replace("\r\n", "\n", $shipped)));
    $keep = []; $depth = 0;
    foreach (explode("\n", $existing) as $line) {
        $t = trim($line);
        if (preg_match('#^</[A-Za-z]#', $t)) { $depth = max(0, $depth - 1); continue; }
        if (preg_match('#^<[A-Za-z]#', $t)) { $depth++; continue; }
        if ($depth > 0 || $t === '' || $t[0] === '#') continue;
        if (!preg_match('/^(AddHandler|SetHandler|AddType|Action|php_value|php_flag|php_admin_value|php_admin_flag|RewriteBase|SetEnv|PassEnv|FcgidWrapper|suPHP_\w+|DirectoryIndex)\b/i', $t)) continue;
        if (in_array($t, $shippedLines, true)) continue;
        $keep[] = $t;
    }
    if (!$keep) return $block;
    return "# Operator lines kept across updates — host-specific directives go here, outside\n"
         . "# the LUMEN3D block (which every update rewrites).\n"
         . implode("\n", $keep) . "\n\n" . $block;
}

/** @return array{0:int,1:array} [httpStatus, payload] — apply the latest GitHub
 *  release in place. No rollback under PHP (per-request runtime; a failed apply
 *  can simply be re-run — the copy pass is idempotent). One apply at a time: a
 *  second click (or a second admin) is refused while the first runs, instead of two
 *  copy passes racing over the same files. */
function admin_update_apply_php(): array {
    $lock = @fopen(admin_private_dir() . '/.update.lock', 'c');
    if ($lock === false) return [500, ['error' => 'update_lock_failed']];
    if (!@flock($lock, LOCK_EX | LOCK_NB)) { @fclose($lock); return [409, ['error' => 'update_in_progress']]; }
    try {
        return admin_update_apply_locked();
    } finally {
        @flock($lock, LOCK_UN);
        @fclose($lock);
    }
}

/**
 * The assets of a GitHub release the updater may apply (twin of the asset choice in
 * dev_server.py _update_check). Only the archive NAMED after the tag is ever
 * applied: any other lumen3d-web-*.zip (an extra one attached by hand, a stale one)
 * is refused, two candidates for the same name make the release ambiguous, and
 * GitHub's raw source zipball is never a candidate (no SHA256SUMS lists it).
 * @return array{zipUrl:?string,assetName:?string,assetSize:?int,sumsUrl:?string,sigUrl:?string,error:?string}
 */
function admin_release_assets(array $rel, string $latest): array {
    $out = ['zipUrl' => null, 'assetName' => null, 'assetSize' => null, 'sumsUrl' => null, 'sigUrl' => null, 'error' => null];
    $wanted = $latest !== '' ? strtolower("lumen3d-web-$latest.zip") : null;
    $candidates = []; $exact = [];
    foreach ((is_array($rel['assets'] ?? null) ? $rel['assets'] : []) as $a) {
        if (!is_array($a)) continue;
        $n = (string)($a['name'] ?? ''); $u = (string)($a['browser_download_url'] ?? '');
        if (preg_match('/^lumen3d-web-.*\.zip\z/i', $n)) {
            $candidates[] = $a;
            if ($wanted !== null && strtolower($n) === $wanted) $exact[] = $a;
        } elseif ($n === 'SHA256SUMS') {
            $out['sumsUrl'] = $u !== '' ? $u : null;
        } elseif ($n === 'SHA256SUMS.sig') {
            $out['sigUrl'] = $u !== '' ? $u : null;
        }
    }
    if (count($exact) === 1) {
        $out['zipUrl'] = (string)($exact[0]['browser_download_url'] ?? '') ?: null;
        $out['assetName'] = (string)$exact[0]['name'];
        $out['assetSize'] = isset($exact[0]['size']) ? (int)$exact[0]['size'] : null;
        if ($out['zipUrl'] === null) $out['error'] = 'no_release_asset';
    } elseif (count($exact) > 1) {
        $out['error'] = 'ambiguous_asset';
    } else {
        $out['error'] = $candidates ? 'asset_name_mismatch' : 'no_release_asset';
    }
    if ($out['error'] === null && $out['sumsUrl'] === null) $out['error'] = 'no_checksums';
    return $out;
}

/** The asset fields of update_check, named as dev_server.py names them. */
function admin_update_check_assets(array $rel, string $latest): array {
    $a = admin_release_assets($rel, $latest);
    return ['assetUrl' => $a['zipUrl'], 'assetName' => $a['assetName'], 'assetSize' => $a['assetSize'],
            'sumsUrl' => $a['sumsUrl'], 'sigUrl' => $a['sigUrl'], 'assetError' => $a['error'],
            'signingConfigured' => LUMEN_RELEASE_PUBKEY !== ''];
}

function admin_update_apply_locked(): array {
    if (!class_exists('ZipArchive')) return [500, ['error' => 'zip_unavailable']];
    @set_time_limit(600);
    $root = admin_root();

    // 1. Resolve the latest release + its assets.
    $raw = mkt_fetch_bytes('https://api.github.com/repos/' . GITHUB_REPO . '/releases/latest', 512 * 1024);
    $rel = $raw !== null ? json_decode($raw, true) : null;
    if (!is_array($rel) || !is_array($rel['assets'] ?? null)) return [502, ['error' => 'release_unreachable']];
    $latest = ltrim((string)($rel['tag_name'] ?? ''), 'v');
    $current = admin_max_version(changelog_dir()) ?? '0.0.0';
    if ($latest === '' || admin_version_tuple($latest) <= admin_version_tuple($current)) {
        return [400, ['error' => 'no_update_available', 'current' => $current, 'latest' => $latest]];
    }
    $assets = admin_release_assets($rel, $latest);
    if ($assets['error'] !== null) {
        return [400, ['error' => 'unverifiable_release', 'reason' => $assets['error'], 'latest' => $latest]];
    }
    [$zipUrl, $sumsUrl, $sigUrl] = [$assets['zipUrl'], $assets['sumsUrl'], $assets['sigUrl']];

    // 2. Download + verify. SHA256SUMS authenticates the zip; the pinned key (when
    //    set) authenticates SHA256SUMS itself — same chain as install.php.
    $sums = mkt_fetch_bytes($sumsUrl, 64 * 1024);
    if ($sums === null) return [502, ['error' => 'sums_unreachable']];
    if (LUMEN_RELEASE_PUBKEY !== '') {
        if (!function_exists('sodium_crypto_sign_verify_detached')) return [500, ['error' => 'sodium_unavailable']];
        $sigHex = $sigUrl !== null ? mkt_fetch_bytes($sigUrl, 4096) : null;
        $sig = $sigHex !== null ? @hex2bin(trim($sigHex)) : false;
        $pub = @hex2bin(LUMEN_RELEASE_PUBKEY);
        if ($sig === false || strlen((string)$sig) !== 64 || $pub === false || strlen((string)$pub) !== 32
            || !sodium_crypto_sign_verify_detached($sig, $sums, $pub)) {
            return [502, ['error' => 'release_signature_invalid']];
        }
    }
    // Fail closed: a release whose zip is not listed in its SHA256SUMS is refused,
    // never installed unverified.
    $zipName = basename((string)parse_url($zipUrl, PHP_URL_PATH));
    $expect = null;
    foreach (preg_split('/\r?\n/', $sums) as $line) {
        if (preg_match('/^([0-9a-fA-F]{64})\s+\*?(.+)$/', trim($line), $m) && trim($m[2]) === $zipName) { $expect = strtolower($m[1]); break; }
    }
    if ($expect === null) return [400, ['error' => 'unverifiable_release', 'reason' => 'zip_not_in_sums', 'latest' => $latest]];

    // 3. Staged download + extract under the web root (same filesystem → rename is
    //    cheap and same-volume; extracting under /tmp broke on shared hosts — EXDEV).
    //    The zip streams to disk: a release held in memory could exceed memory_limit.
    $staging = $root . '/.update-staging-' . bin2hex(random_bytes(4));
    if (!admin_make_dir($staging)) return [500, ['error' => 'staging_mkdir_failed']];
    $zipPath = $staging . '/release.zip';
    if (!mkt_fetch_to_file($zipUrl, $zipPath, 64 * 1024 * 1024)) { mkt_rmrf($staging); return [502, ['error' => 'zip_unreachable']]; }
    $actual = hash_file('sha256', $zipPath);
    if (!is_string($actual) || !hash_equals($expect, $actual)) { mkt_rmrf($staging); return [502, ['error' => 'zip_digest_mismatch']]; }
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) { mkt_rmrf($staging); return [500, ['error' => 'zip_open_failed']]; }
    if ($zip->numFiles > 5000) { $zip->close(); mkt_rmrf($staging); return [500, ['error' => 'zip_too_large']]; }
    $names = []; $total = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $st = $zip->statIndex($i);
        $name = (string)$st['name'];
        if ($name === '' || substr($name, -1) === '/') continue;                    // directory entries
        $segs = explode('/', $name);
        $first = $segs[0];
        // Canonical posix path only. Reject traversal AND '.'/'' segments + '//'
        // — a release zip never contains them, and a '.' alias (e.g.
        // "api/./admin_credential.json") would otherwise slip past the literal
        // string match in admin_update_protected() while the FS resolves it to a
        // protected file. Defense-in-depth atop the TLS-authenticated source.
        if ($name[0] === '/' || strpos($name, '\\') !== false || strpos($first, ':') !== false
            || in_array('..', $segs, true) || in_array('.', $segs, true) || in_array('', $segs, true)) {
            $zip->close(); mkt_rmrf($staging); return [500, ['error' => 'zip_entry_unsafe']];
        }
        $total += (int)$st['size'];
        if ($total > 128 * 1024 * 1024) { $zip->close(); mkt_rmrf($staging); return [500, ['error' => 'zip_too_large']]; }
        $names[] = $name;
    }
    $exDir = $staging . '/x';
    admin_make_dir($exDir);
    if (!$zip->extractTo($exDir)) { $zip->close(); mkt_rmrf($staging); return [500, ['error' => 'zip_extract_failed']]; }
    $zip->close();

    // 4. Move files into place, skipping protected paths. Overwriting the very
    //    scripts serving this request is safe under PHP (already compiled). On
    //    Windows an OPEN file can't be unlinked but CAN be renamed — park the old
    //    file aside as *.lumen-old, then place the new one; leftovers are swept
    //    below (and by the next run once the handle is released).
    //
    //    Copy the changelog/ files LAST: admin_max_version() derives the deployed
    //    version from changelog filenames, and it is the retry gate (a
    //    <=-comparison rejects re-applying the same version). If a mid-copy
    //    failure (quota, FPM kill) landed the new changelog early, a retry would
    //    see the new version and refuse to finish — leaving a broken old/new mix.
    //    Writing changelog last means a partial run keeps the OLD version, so
    //    re-running heals it (the copy pass is idempotent).
    usort($names, function ($a, $b) {
        $ca = strncmp($a, 'changelog/', 10) === 0 ? 1 : 0;
        $cb = strncmp($b, 'changelog/', 10) === 0 ? 1 : 0;
        return $ca !== $cb ? $ca - $cb : strcmp($a, $b);
    });
    $updated = 0; $skipped = 0; $pending = []; $phpWritten = [];
    foreach ($names as $relPath) {
        if (admin_update_protected($relPath)) { $skipped++; continue; }
        $srcF = $exDir . '/' . $relPath;
        if (!is_file($srcF)) continue;
        $dstF = $root . '/' . $relPath;
        $dir = dirname($dstF);
        if (!admin_make_dir($dir)) { mkt_rmrf($staging); return [500, ['error' => 'mkdir_failed', 'path' => $relPath, 'filesUpdated' => $updated]]; }
        // Rename-aside FIRST: it frees the name atomically and works even on an
        // OPEN file (Windows allows rename, not delete-in-place; a plain unlink
        // there only marks delete-pending and the name stays blocked until the
        // handle closes — the new file then can't land). unlink is the fallback.
        if ($relPath === '.htaccess' && is_file($dstF)) {
            // Keep the operator's own lines (see admin_merge_htaccess); a copy of the
            // previous file stays beside it, denied like every dotfile.
            $prev = (string)@file_get_contents($dstF);
            $merged = admin_merge_htaccess($prev, (string)@file_get_contents($srcF));
            @file_put_contents($dstF . '.lumen-backup', $prev);
            if (!lumen_write_file_atomic($dstF, $merged, admin_code_file_mode())) {
                mkt_rmrf($staging);
                return [500, ['error' => 'write_failed', 'path' => $relPath, 'filesUpdated' => $updated]];
            }
            $updated++;
            continue;
        }
        if (file_exists($dstF)) {
            @unlink($dstF . '.lumen-old');
            if (!@rename($dstF, $dstF . '.lumen-old')) @unlink($dstF);
        }
        if (!@rename($srcF, $dstF) && !@copy($srcF, $dstF)) {
            // Name still blocked (delete-pending / AV lock): park the new bytes
            // beside it; a later request finalizes (admin_update_finish_pending).
            if (@rename($srcF, $dstF . '.lumen-new') || @copy($srcF, $dstF . '.lumen-new')) { $pending[] = $relPath; $updated++; continue; }
            mkt_rmrf($staging);
            return [500, ['error' => 'write_failed', 'path' => $relPath, 'filesUpdated' => $updated]];
        }
        admin_fix_file_mode($dstF);
        if (substr($relPath, -4) === '.php') $phpWritten[] = $dstF;
        $updated++;
    }
    foreach ($names as $relPath) @unlink($root . '/' . $relPath . '.lumen-old');   // best-effort sweep
    foreach (ADMIN_UPDATE_OBSOLETE as $gone) {
        if (!in_array($gone, $names, true) && is_file($root . '/' . $gone)) @unlink($root . '/' . $gone);
    }
    mkt_rmrf($staging);
    if ($pending) @file_put_contents($root . '/api/.update-pending.json', json_encode(array_values($pending)));
    admin_opcache_flush($phpWritten);   // else opcache serves the OLD compiled *.php
    return [200, ['ok' => true, 'applied' => $latest, 'from' => $current, 'filesUpdated' => $updated,
                  'skippedProtected' => $skipped, 'pendingFinalize' => count($pending),
                  'signature' => LUMEN_RELEASE_PUBKEY !== '' ? 'verified' : 'sha256-only']];
}

/** Drop stale bytecode for freshly-overwritten *.php so the NEW code answers the
 *  next request. Without this, a host with opcache (validate_timestamps off or a
 *  long revalidate_freq — common on mutualisé perf tuning) keeps executing the
 *  pre-update admin.php/_admin_lib.php after the update "succeeded". Per-file
 *  invalidate (less likely blocked by opcache.restrict_api than opcache_reset). */
function admin_opcache_flush(array $phpPaths): void {
    if (!function_exists('opcache_invalidate')) { if (function_exists('opcache_reset')) @opcache_reset(); return; }
    foreach ($phpPaths as $p) @opcache_invalidate($p, true);
}

/** Finish a self-update whose busy files (Windows) were parked as *.lumen-new —
 *  swap them into place once their handles are released. Cheap no-op when the
 *  marker is absent (the Linux path). Never touches the entry script currently
 *  executing; the next request through ANOTHER endpoint finalizes that one. */
function admin_update_finish_pending(): void {
    $root = admin_root();
    $marker = $root . '/api/.update-pending.json';
    if (!is_file($marker)) return;
    $list = json_decode((string)@file_get_contents($marker), true);
    if (!is_array($list)) { @unlink($marker); return; }
    $self = str_replace('\\', '/', (string)@realpath((string)($_SERVER['SCRIPT_FILENAME'] ?? '')));
    $left = []; $swapped = [];
    foreach ($list as $rel) {
        if (!is_string($rel) || $rel === '' || strpos($rel, '..') !== false) continue;
        $dst = $root . '/' . $rel;
        $new = $dst . '.lumen-new';
        if (!is_file($new)) { @unlink($dst . '.lumen-old'); continue; }        // already finalized
        if ($self !== '' && str_replace('\\', '/', (string)@realpath($dst)) === $self) { $left[] = $rel; continue; }
        if (file_exists($dst)) {
            @unlink($dst . '.lumen-old');
            if (!@rename($dst, $dst . '.lumen-old')) @unlink($dst);
        }
        if (!@rename($new, $dst) && !@copy($new, $dst)) { $left[] = $rel; continue; }
        admin_fix_file_mode($dst);
        @unlink($new);
        @unlink($dst . '.lumen-old');
        if (substr($rel, -4) === '.php') $swapped[] = $dst;
    }
    if ($swapped) admin_opcache_flush($swapped);
    if ($left) @file_put_contents($marker, json_encode(array_values($left)));
    else @unlink($marker);
}

// ── One-shot migration: relocate inline page drafts out of the public tree ────
// Documents written before the draft split kept `draft` inside
// config/pages/<slug>.json, which is served statically to every visitor. Rewriting
// them on the next save is not enough: the stale public copy keeps leaking until
// someone happens to edit that page. This runs once per installation (guarded by a
// marker) on the first api/*.php request after the update, so an upgraded host is
// clean before anyone opens the admin panel.
function admin_migrate_inline_drafts(): void {
    $marker = __DIR__ . '/page-drafts/.migrated';
    if (is_file($marker)) return;
    $complete = true;
    $dir = admin_root() . '/config/pages';
    if (is_dir($dir)) {
        foreach ((array)glob($dir . '/*.json') as $f) {
            $doc = json_decode((string)@file_get_contents($f), true);
            if (!is_array($doc) || !isset($doc['draft'])) continue;
            $slug = basename($f, '.json');
            if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,63}$/D', $slug)) continue;
            $draft = $doc['draft'];
            unset($doc['draft']);
            $target = __DIR__ . '/page-drafts/' . $slug . '.json';
            if (!is_dir(dirname($target))) admin_make_dir(dirname($target));
            // Park FIRST, strip second, and never strip when parking failed: the
            // public copy is the only remaining copy of that draft, so a read-only
            // api/ would otherwise destroy the operator's unpublished work to fix a
            // confidentiality bug. A non-array draft carries nothing to lose.
            if (is_array($draft) && !admin_write_json($target, $draft)) {
                $complete = false;
                continue;
            }
            $json = json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
            if ($json === false || !lumen_write_file_atomic($f, $json)) {
                $complete = false;
                continue;
            }
        }
    }
    // Only claim the sweep is done when every page actually moved — otherwise the
    // marker would freeze a half-migrated tree and the leak would never be retried.
    if (!$complete) return;
    if (!is_dir(dirname($marker))) admin_make_dir(dirname($marker));
    @file_put_contents($marker, date('c'));
    @chmod($marker, 0600);
}

admin_migrate_inline_drafts();
