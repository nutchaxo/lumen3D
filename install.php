<?php
/**
 * Lumen3D — Standalone web installer (single file).
 * =================================================
 * Drop this file into an EMPTY web directory on any PHP >= 7.4 host, open it in
 * a browser, and it downloads the latest Lumen3D release from GitHub, verifies
 * it, extracts it safely, and configures the admin account.
 *
 * Design guarantees:
 *  - Nothing destructive happens before the download is fully verified.
 *  - Every step is idempotent and resumable (.install-state.json, byte-range
 *    resume on the download, batched extraction driven by browser AJAX ticks).
 *  - Self-locking: refuses to run if api/admin_credential.json or .install-lock
 *    exists; offers CSRF-protected self-deletion.
 *  - Every zip entry is validated (no traversal, no symlinks, no absolute
 *    paths); install.php itself is never overwritten; zip-bomb caps enforced.
 *
 * Roles by request type:
 *  - GET  (no params)  → self-contained UI page (inline CSS/JS, no CDN).
 *  - POST ?api=<step>  → JSON API: status, check, download, extract, verify,
 *                        configure, finalize, reset, selfdelete.
 */

declare(strict_types=1);

// ── Constants ────────────────────────────────────────────────────────────────

const GITHUB_REPO = 'nutchaxo/lumen3D';                    // HARDCODED — never user-controllable
const GITHUB_API_LATEST = 'https://api.github.com/repos/' . GITHUB_REPO . '/releases/latest';
const INSTALLER_UA = 'Lumen3D-Installer/1.0 (+https://github.com/' . GITHUB_REPO . ')';

// Release authenticity (L7): the project signing PUBLIC key (Ed25519, 32-byte hex).
// CI signs SHA256SUMS with the matching private seed; the installer verifies the
// detached SHA256SUMS.sig against THIS pinned key (PHP's built-in libsodium) before
// trusting the manifest — the manifest then pins the archive's sha256.
//   - Empty  → authenticity "not configured": sha256 integrity only (with a notice).
//   - Set    → signature is MANDATORY (fail-closed): a release that is unsigned, or
//              whose signature does not verify, is REFUSED before any extraction.
// Keep in lockstep with dev_server.py `_RELEASE_PUBKEY_HEX`. See tools/gen_signing_key.py.
const PINNED_PUBKEY = '';

const STATE_FILE = '.install-state.json';
const LOCK_FILE  = '.install-lock';
const PART_FILE  = '.install-download.zip.part';
const CA_SEED_FILE = '.lumen-ca-seed.pem';                  // embedded CA bundle, materialized on demand
const ZIP_FILE   = '.install-download.zip';

const MAX_ENTRIES            = 20000;                      // zip-bomb: entry count cap
const MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024;          // zip-bomb: 500 MB uncompressed cap
const MAX_ZIP_BYTES          = 512 * 1024 * 1024;          // sanity cap on the compressed archive

const TICK_BYTES        = 8 * 1024 * 1024;                 // per download tick (ranged hosts)
const TICK_SECONDS      = 10;                              // per download tick (ranged hosts)
const NORANGE_SECONDS   = 280;                             // single-shot budget when host ignores Range
const EXTRACT_BATCH     = 200;                             // entries per extract tick
const EXTRACT_SECONDS   = 8;                               // time budget per extract tick
const MAX_REDIRECTS     = 5;                               // https-only redirects
const CONNECT_TIMEOUT   = 15;

const PBKDF2_ITERS    = 200000;                            // matches api/_admin_lib.php + dev_server.py
const MIN_PASSWORD    = 8;

// ── Paths ────────────────────────────────────────────────────────────────────

function target_dir(): string { return __DIR__; }

/** Join a validated relative path onto the target dir (forward slashes). */
function tpath(string $rel): string { return target_dir() . '/' . $rel; }

function credential_path(): string { return tpath('api/admin_credential.json'); }

/** Normalize a filesystem path to forward slashes for prefix comparisons. */
function norm_path(string $p): string { return rtrim(str_replace('\\', '/', $p), '/'); }

/** True when $abs (an existing path) resolves inside the target directory. */
function within_target(string $abs): bool {
    $t = realpath(target_dir());
    $r = realpath($abs);
    if ($t === false || $r === false) return false;
    $t = norm_path($t);
    $r = norm_path($r);
    return $r === $t || strncmp($r . '/', $t . '/', strlen($t) + 1) === 0;
}

// ── JSON I/O ─────────────────────────────────────────────────────────────────

function json_out(array $data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function json_fail(string $errorCode, int $httpCode = 400, array $extra = []): void {
    json_out(array_merge(['ok' => false, 'error' => $errorCode], $extra), $httpCode);
}

/** Parsed JSON POST body (empty array when absent/invalid). */
function post_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return [];
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

// ── Install state (.install-state.json — never contains secrets) ────────────

function read_state(): ?array {
    $f = tpath(STATE_FILE);
    if (!is_file($f)) return null;
    $raw = file_get_contents($f);
    if ($raw === false) return null;
    $d = json_decode($raw, true);
    // Corrupt state file → treat as absent so the flow resets gracefully.
    if (!is_array($d) || !isset($d['phase'])) return null;
    return $d;
}

function write_state(array $state): bool {
    $f = tpath(STATE_FILE);
    $tmp = $f . '.tmp';
    if (file_put_contents($tmp, json_encode($state, JSON_UNESCAPED_UNICODE)) === false) {
        @unlink($tmp);
        return false;
    }
    if (!@rename($tmp, $f)) { @unlink($tmp); return false; }
    @chmod($f, 0600);                                       // best-effort (no-op on Windows)
    return true;
}

/** Load state and require one of the given phases; 409 otherwise. */
function require_state(array $phases): array {
    $s = read_state();
    if ($s === null) json_fail('no_state', 409);
    if (!in_array($s['phase'], $phases, true)) json_fail('wrong_phase', 409, ['phase' => $s['phase']]);
    return $s;
}

/** Delete download artifacts (and optionally the state file). Never touches installed files. */
function clear_artifacts(bool $includeState): void {
    foreach ([PART_FILE, ZIP_FILE] as $rel) {
        $p = tpath($rel);
        if (is_file($p)) @unlink($p);
    }
    if ($includeState) {
        $p = tpath(STATE_FILE);
        if (is_file($p)) @unlink($p);
    }
}

// ── Self-locking ─────────────────────────────────────────────────────────────

/**
 * The installer refuses to act on an already-live platform. It locks once the
 * LOCK_FILE is written (finalize). A fresh install has no admin credential yet
 * — that account is created by the platform's guided setup wizard on first
 * visit, not here — so absence of the credential means "install may proceed".
 * A credential that DOES exist without our lock means a live platform: stay
 * locked unless we are still mid-flow (state phase 'configured', pre-finalize).
 */
function is_locked(): bool {
    if (file_exists(tpath(LOCK_FILE))) return true;
    if (!file_exists(credential_path())) return false;
    $s = read_state();
    return !($s !== null && ($s['phase'] ?? '') === 'configured');
}

// ── Session + CSRF ───────────────────────────────────────────────────────────

function install_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_set_cookie_params([
        'lifetime' => 0, 'path' => '/',
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true, 'samesite' => 'Lax',
    ]);
    session_name('lumen3d_install');
    session_start();
}

function csrf_token(): string {
    if (empty($_SESSION['install_csrf'])) $_SESSION['install_csrf'] = bin2hex(random_bytes(32));
    return $_SESSION['install_csrf'];
}

function check_csrf(): bool {
    $sent = $_SERVER['HTTP_X_INSTALL_CSRF'] ?? ($_POST['_csrf'] ?? '');
    if ($sent === '') { $body = post_body(); $sent = (string)($body['_csrf'] ?? ''); }
    return !empty($_SESSION['install_csrf']) && is_string($sent)
        && hash_equals((string)$_SESSION['install_csrf'], $sent);
}

// ── Filesystem permissions (keep the site editable over FTP/SFTP) ────────────
// install.php is uploaded by the operator's FTP/SFTP account, so ITS owner is that
// account. Where PHP runs as a DIFFERENT system user (www-data, apache, a shared
// php-fpm pool), everything created here would be owned by PHP in 0755/0644, and
// the operator could then neither upload into those directories nor delete what is
// inside them — POSIX takes the right to delete a file from its PARENT DIRECTORY,
// not from the file itself. That is what makes a fresh install look "untouchable".
//
// So we detect the split and, only then, create world-writable (0777/0666) so the
// site stays under its owner's control. On a correctly configured host (PHP running
// as the account, suEXEC / per-user pool) nothing changes: 0755/0644 as before.
// Secrets keep their restrictive mode — the operator can still delete them, since
// that right comes from the parent directory. Override: LUMEN_DIR_MODE/LUMEN_FILE_MODE.

function perms_owner_split(): bool {
    static $split = null;
    if ($split !== null) return $split;
    if (DIRECTORY_SEPARATOR !== '/') return $split = false;                  // no POSIX modes on Windows
    $self = @fileowner(__FILE__);
    if ($self === false) return $split = false;
    if (function_exists('posix_geteuid')) return $split = ($self !== posix_geteuid());
    // No ext-posix: compare the owner of a file PHP creates with the owner of this file.
    $probe = tpath('.install-probe');
    if (@file_put_contents($probe, '') === false) return $split = false;
    $mine = @fileowner($probe);
    @unlink($probe);
    return $split = ($mine !== false && $mine !== $self);
}

function mode_override(string $env): ?int {
    $v = getenv($env);
    if ($v === false || !preg_match('/^0?[0-7]{3,4}$/', trim((string)$v))) return null;
    return (int)intval(trim((string)$v), 8);
}

/**
 * Modes are INHERITED FROM THE TARGET DIRECTORY: that is what the hosting account
 * was set up with, and it already encodes how this host shares the site. The common
 * shared-hosting layout is `user:client 0770` — PHP and the SFTP login are different
 * users of the SAME GROUP, so files must be GROUP-writable (0770/0660). Creating
 * 0755/0644 there locks the operator out of their own site; 0777/0666 would grant
 * far more than needed. World-writable is kept only for the case inheritance cannot
 * cover: a root writable by nobody but its owner, with PHP not being that owner.
 * @return array{0:int,1:int} [dirMode, fileMode]
 */
function base_modes(): array {
    static $cached = null;
    if ($cached !== null) return $cached;
    if (DIRECTORY_SEPARATOR !== '/') return $cached = [0755, 0644];
    $perms = @fileperms(target_dir());
    if ($perms === false) return $cached = [0755, 0644];
    $base = $perms & 0777;
    if (perms_owner_split() && ($base & 0022) === 0) $base |= 0022;
    return $cached = [$base | 0700, ($base & 0666) | 0600];
}

function dir_mode(): int  { return mode_override('LUMEN_DIR_MODE')  ?? base_modes()[0]; }
function file_mode(): int { return mode_override('LUMEN_FILE_MODE') ?? base_modes()[1]; }

/**
 * mkdir + explicit chmod. mkdir()'s mode argument is masked by the process umask
 * (typically 022, which silently strips group/other write), so the mode has to be
 * set afterwards — for EVERY level a recursive mkdir may have created.
 */
function make_dir(string $path): bool {
    if (is_dir($path)) return true;
    if (!@mkdir($path, dir_mode(), true) && !is_dir($path)) return false;
    $mode = dir_mode();
    $cur  = rtrim(str_replace('\\', '/', $path), '/');
    $root = rtrim(str_replace('\\', '/', target_dir()), '/');
    while ($cur !== '' && strlen($cur) > strlen($root) && strncmp($cur, $root, strlen($root)) === 0) {
        @chmod($cur, $mode);
        $cur = dirname($cur);
    }
    return true;
}

/** Apply the resolved file mode to something we just wrote (no-op on Windows). */
function fix_file_mode(string $path): void { @chmod($path, file_mode()); }

/** Secrets that keep a restrictive mode (deleting them only needs the parent dir). */
function is_secret_path(string $rel): bool {
    return (strncmp($rel, 'api/', 4) === 0 && substr($rel, -5) === '.json')
        || $rel === STATE_FILE || $rel === STATE_FILE . '.tmp';
}

/**
 * Safety net over the extracted tree: re-apply the resolved modes everywhere, so a
 * write path added later cannot silently leave the operator locked out. No-op when
 * PHP already runs as the site owner. Symlinks are never followed.
 * @return array{0:int,1:int} [entries touched, failures]
 */
function apply_tree_modes(): array {
    if (DIRECTORY_SEPARATOR !== '/') return [0, 0];
    $root = target_dir();
    $dirMode = dir_mode(); $fileMode = file_mode();
    $done = 0; $failed = 0; $seen = 0;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS | FilesystemIterator::UNIX_PATHS),
        RecursiveIteratorIterator::SELF_FIRST,
        RecursiveIteratorIterator::CATCH_GET_CHILD          // an unreadable dir must not abort the walk
    );
    foreach ($it as $path => $info) {
        if (++$seen > MAX_ENTRIES) break;                                    // same cap as the zip walk
        if ($info->isLink()) continue;
        $rel = ltrim(substr(str_replace('\\', '/', (string)$path), strlen(rtrim(str_replace('\\', '/', $root), '/'))), '/');
        if ($rel === '' || is_secret_path($rel) || $rel === basename(__FILE__)) continue;
        $want = $info->isDir() ? $dirMode : $fileMode;
        if ((@fileperms((string)$path) & 0777) === $want) continue;
        if (@chmod((string)$path, $want)) $done++; else $failed++;
    }
    return [$done, $failed];
}

// ── HTTPS client (curl preferred, stream fallback; https-only, max 5 redirects) ──

function https_only(string $url): bool { return strncasecmp($url, 'https://', 8) === 0; }

function http_capable(): bool {
    return extension_loaded('curl') || filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN);
}

function stream_capable(): bool {
    return filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN);
}

// ── CA trust store repair ────────────────────────────────────────────────────
// Some shared hosts ship a php.ini whose curl.cainfo / openssl.cafile names a
// bundle that was never installed (e.g. /usr/share/php/cacert.pem). cURL then
// aborts BEFORE opening the socket — "error setting certificate file: …" — and
// the stream wrapper fails peer verification for the same reason, so the host
// looks offline when it is not. We locate a real bundle and hand it to the
// transport explicitly. Peer verification is NEVER disabled.

/** @return array{0:?string,1:?string} [cafile, capath]; [null,null] = none found. */
function ca_probe(): array {
    static $cached = null;
    if ($cached !== null) return $cached;
    $files = [
        tpath('cacert.pem'),                       // operator override (upload next to install.php)
        '/etc/ssl/certs/ca-certificates.crt',      // Debian / Ubuntu
        '/etc/pki/tls/certs/ca-bundle.crt',        // RHEL / CentOS / Fedora
        '/etc/ssl/ca-bundle.pem',                  // SUSE
        '/etc/pki/tls/cacert.pem',
        '/etc/ssl/cert.pem',                       // Alpine / BSD / macOS
        '/usr/local/share/certs/ca-root-nss.crt',  // FreeBSD
        '/usr/local/etc/openssl/cert.pem',
        tpath('api/ca-bundle.pem'),                // shipped by the release (present after extraction)
        tpath(CA_SEED_FILE),                       // seeded by a previous run of this installer
    ];
    foreach ($files as $f) if (@is_readable($f)) return $cached = [$f, null];
    foreach (['/etc/ssl/certs', '/etc/pki/tls/certs'] as $d) if (@is_dir($d)) return $cached = [null, $d];
    $seeded = ca_write_seed();                     // last resort: materialize the embedded bundle
    return $cached = [$seeded, null];
}

/**
 * Materialize the embedded Mozilla bundle so cURL/OpenSSL have a real trust store.
 * This is the difference between "the operator must find and upload a cacert.pem"
 * and "the installer just works" on a host whose php.ini points at a missing CA
 * file and whose system store is unreadable (open_basedir hiding /etc/ssl).
 */
function ca_write_seed(): ?string {
    $path = tpath(CA_SEED_FILE);
    if (@is_readable($path)) return $path;
    $pem = embedded_ca_bundle();
    if (strpos($pem, '-----BEGIN CERTIFICATE-----') === false) return null;
    if (@file_put_contents($path, $pem) === false) return null;   // read-only dir → caller reports it
    fix_file_mode($path);
    return @is_readable($path) ? $path : null;
}

/** True when php.ini names a CA file that does not exist → default trust store unusable. */
function ca_ini_broken(): bool {
    foreach (['curl.cainfo', 'openssl.cafile'] as $k) {
        $v = (string)ini_get($k);
        if ($v !== '' && !@is_readable($v)) return true;
    }
    return false;
}

/** curl options repairing the trust store. Empty on a healthy host unless forced. */
function ca_curl_opts(bool $force = false): array {
    if (!$force && !ca_ini_broken()) return [];
    [$file, $dir] = ca_probe();
    $o = [];
    if ($file !== null) $o[CURLOPT_CAINFO] = $file;
    elseif ($dir !== null) $o[CURLOPT_CAPATH] = $dir;
    return $o;
}

/** ssl:// stream-context options, same policy. */
function ca_stream_opts(bool $force = false): array {
    $ssl = ['verify_peer' => true, 'verify_peer_name' => true];
    if (!$force && !ca_ini_broken()) return $ssl;
    [$file, $dir] = ca_probe();
    if ($file !== null) $ssl['cafile'] = $file;
    elseif ($dir !== null) $ssl['capath'] = $dir;
    return $ssl;
}

/** Distinguishes "trust store unusable" from "network down" in a curl/TLS error. */
function is_ca_error(?string $err): bool {
    if ($err === null || $err === '') return false;
    $e = strtolower($err);
    foreach (['certificate file', 'cacert', 'ca cert', 'trust anchor', 'local issuer', 'certificate verify failed',
              'unable to get issuer', 'ssl ca', 'self signed certificate in certificate chain'] as $needle) {
        if (strpos($e, $needle) !== false) return true;
    }
    return false;
}

/**
 * Small HTTPS GET for API JSON / checksum files (body buffered in memory).
 * Returns ['ok'=>bool,'status'=>int,'headers'=>array<lower,string>,'body'=>string,'error'=>?string].
 */
function http_get_small(string $url, array $extraHeaders = []): array {
    if (!https_only($url)) return ['ok' => false, 'status' => 0, 'headers' => [], 'body' => '', 'error' => 'not_https'];
    $headers = array_merge(['User-Agent: ' . INSTALLER_UA, 'Accept: */*'], $extraHeaders);

    if (extension_loaded('curl')) {
        $res = curl_get_small($url, $headers, ca_curl_opts());
        if (!$res['ok'] && is_ca_error($res['error'])) {
            $forced = ca_curl_opts(true);                                     // probe even if the ini looked sane
            if ($forced !== []) $res = curl_get_small($url, $headers, $forced);
        }
        // Streams use OpenSSL's own defaults, which can still work when curl's are broken.
        if ($res['ok'] || !is_ca_error($res['error']) || !stream_capable()) return $res;
        $caError = $res['error'];
    }

    $res = stream_get_small($url, $headers);
    // Keep the CA diagnosis when the stream fallback also fails: its own error is a
    // bare "network", which would send the operator hunting a firewall that is fine.
    if (!$res['ok'] && isset($caError) && !is_ca_error($res['error'])) $res['error'] = $caError;
    return $res;
}

/** curl branch of http_get_small. */
function curl_get_small(string $url, array $headers, array $caOpts): array {
    $respHeaders = [];
    $ch = curl_init($url);
    curl_setopt_array($ch, $caOpts + [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => MAX_REDIRECTS,
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) {
            if (stripos($line, 'HTTP/') === 0) { $respHeaders = []; }                     // new hop → reset
            elseif (strpos($line, ':') !== false) {
                [$k, $v] = explode(':', $line, 2);
                $respHeaders[strtolower(trim($k))] = trim($v);
            }
            return strlen($line);
        },
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) return ['ok' => false, 'status' => $status, 'headers' => $respHeaders, 'body' => '', 'error' => $err ?: 'network'];
    return ['ok' => $status >= 200 && $status < 300, 'status' => $status, 'headers' => $respHeaders, 'body' => (string)$body, 'error' => null];
}

/** Stream branch of http_get_small — manual https-only redirect loop. */
function stream_get_small(string $url, array $headers): array {
    $redirects = 0;
    while (true) {
        if (!https_only($url)) return ['ok' => false, 'status' => 0, 'headers' => [], 'body' => '', 'error' => 'redirect_not_https'];
        $ctx = stream_context_create([
            'http' => ['method' => 'GET', 'header' => implode("\r\n", $headers),
                       'follow_location' => 0, 'timeout' => 30, 'ignore_errors' => true],
            'ssl'  => ca_stream_opts(),
        ]);
        $body = @file_get_contents($url, false, $ctx);
        $meta = isset($http_response_header) && is_array($http_response_header) ? $http_response_header : [];
        [$status, $respHeaders] = parse_response_headers($meta);
        if ($status >= 300 && $status < 400 && isset($respHeaders['location'])) {
            if (++$redirects > MAX_REDIRECTS) return ['ok' => false, 'status' => $status, 'headers' => $respHeaders, 'body' => '', 'error' => 'too_many_redirects'];
            $url = resolve_redirect($url, $respHeaders['location']);
            continue;
        }
        if ($body === false) return ['ok' => false, 'status' => $status, 'headers' => $respHeaders, 'body' => '', 'error' => 'network'];
        return ['ok' => $status >= 200 && $status < 300, 'status' => $status, 'headers' => $respHeaders, 'body' => $body, 'error' => null];
    }
}

/** Parse $http_response_header lines → [status, headers(lowercased)]. Keeps only the LAST response block. */
function parse_response_headers(array $lines): array {
    $status = 0; $headers = [];
    foreach ($lines as $line) {
        if (stripos($line, 'HTTP/') === 0) {
            $headers = [];
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) $status = (int)$m[1];
        } elseif (strpos($line, ':') !== false) {
            [$k, $v] = explode(':', $line, 2);
            $headers[strtolower(trim($k))] = trim($v);
        }
    }
    return [$status, $headers];
}

/** Resolve a Location header against the current URL (absolute or path-only). */
function resolve_redirect(string $current, string $location): string {
    if (preg_match('#^https?://#i', $location)) return $location;
    $p = parse_url($current);
    $base = 'https://' . ($p['host'] ?? '') . (isset($p['port']) ? ':' . $p['port'] : '');
    if ($location !== '' && $location[0] === '/') return $base . $location;
    $dir = isset($p['path']) ? preg_replace('#/[^/]*$#', '/', $p['path']) : '/';
    return $base . $dir . $location;
}

/**
 * One bounded download tick appending to the .part file.
 * Sends Range: bytes=<offset>-<offset+TICK-1>. If the host ignores Range
 * (HTTP 200 — e.g. GitHub zipball via codeload), switches to a single-shot
 * extended budget within the same tick, since restarting 8 MB slices forever
 * would never converge.
 * Returns ['ok','complete','received','total','noRange','error'=>?string,'status'=>int].
 */
function download_tick(string $url, string $partPath, ?int $expectedTotal): array {
    if (!https_only($url)) return dl_err('not_https', 0);
    $offset = is_file($partPath) ? (int)filesize($partPath) : 0;
    if ($expectedTotal !== null && $offset > $expectedTotal) {                // corrupt/oversized part
        @unlink($partPath);
        $offset = 0;
    }
    if ($expectedTotal !== null && $offset === $expectedTotal) {
        return ['ok' => true, 'complete' => true, 'received' => $offset, 'total' => $expectedTotal, 'noRange' => false, 'error' => null, 'status' => 0];
    }
    @set_time_limit(NORANGE_SECONDS + 40);

    $fp = fopen($partPath, $offset > 0 ? 'ab' : 'wb');
    if ($fp === false) return dl_err('disk_write', 0);
    $rangeEnd = $offset + TICK_BYTES - 1;
    if ($expectedTotal !== null && $rangeEnd >= $expectedTotal) $rangeEnd = $expectedTotal - 1;

    if (extension_loaded('curl')) {
        $res = curl_download_tick($url, $fp, $offset, $rangeEnd, $expectedTotal, ca_curl_opts());
        if (!$res['ok'] && is_ca_error($res['error'])) {                          // broken trust store, not the network
            $forced = ca_curl_opts(true);
            if ($forced !== []) $res = curl_download_tick($url, $fp, $offset, $rangeEnd, $expectedTotal, $forced);
            if (!$res['ok'] && is_ca_error($res['error']) && stream_capable()) {
                $res = stream_download_tick($url, $fp, $offset, $rangeEnd, $expectedTotal);
            }
        }
    } else {
        $res = stream_download_tick($url, $fp, $offset, $rangeEnd, $expectedTotal);
    }
    fflush($fp);
    fclose($fp);
    clearstatcache(true, $partPath);
    $res['received'] = is_file($partPath) ? (int)filesize($partPath) : 0;
    if ($res['total'] === null) $res['total'] = $expectedTotal;
    if (!$res['complete'] && $res['total'] !== null && $res['received'] >= $res['total']) $res['complete'] = true;
    if ($res['received'] > MAX_ZIP_BYTES) { @unlink($partPath); return dl_err('too_large', $res['status']); }
    return $res;
}

function dl_err(string $code, int $status): array {
    return ['ok' => false, 'complete' => false, 'received' => 0, 'total' => null, 'noRange' => false, 'error' => $code, 'status' => $status];
}

/** curl branch of download_tick. $fp positioned at $offset (append mode). */
function curl_download_tick(string $url, $fp, int $offset, int $rangeEnd, ?int $expectedTotal, array $caOpts = []): array {
    $ctx = [
        'fp' => $fp, 'written' => 0, 'cap' => TICK_BYTES, 'deadline' => microtime(true) + TICK_SECONDS,
        'status' => 0, 'total' => null, 'bodyStarted' => false, 'capped' => false,
        'diskError' => false, 'httpError' => 0, 'noRange' => false, 'restarted' => false, 'offset' => $offset,
    ];
    $ch = curl_init($url);
    curl_setopt_array($ch, $caOpts + [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => MAX_REDIRECTS,
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT,
        CURLOPT_TIMEOUT        => NORANGE_SECONDS + 20,
        CURLOPT_HTTPHEADER     => [
            'User-Agent: ' . INSTALLER_UA,
            'Accept: application/octet-stream',
            'Range: bytes=' . $offset . '-' . $rangeEnd,
        ],
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$ctx) {
            if (preg_match('#content-range:\s*bytes\s+\d+-\d+/(\d+)#i', $line, $m)) $ctx['total'] = (int)$m[1];
            elseif (preg_match('#^content-length:\s*(\d+)#i', trim($line), $m)) $ctx['contentLength'] = (int)$m[1];
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION  => function ($c, $data) use (&$ctx) {
            $len = strlen($data);
            if (!$ctx['bodyStarted']) {
                $ctx['bodyStarted'] = true;
                $ctx['status'] = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE);
                if ($ctx['status'] >= 400) { $ctx['httpError'] = $ctx['status']; return -1; }
                if ($ctx['status'] === 200) {
                    // Host ignored Range → single-shot mode with an extended budget.
                    $ctx['noRange'] = true;
                    $ctx['cap'] = MAX_ZIP_BYTES;
                    $ctx['deadline'] = microtime(true) + NORANGE_SECONDS;
                    if ($ctx['offset'] > 0) {                                  // discard stale partial bytes
                        ftruncate($ctx['fp'], 0);
                        rewind($ctx['fp']);
                        $ctx['restarted'] = true;
                        $ctx['offset'] = 0;
                    }
                }
            }
            $w = fwrite($ctx['fp'], $data);
            if ($w !== $len) { $ctx['diskError'] = true; return -1; }          // disk full / write failure
            $ctx['written'] += $len;
            if ($ctx['written'] >= $ctx['cap'] || microtime(true) > $ctx['deadline']) {
                $ctx['capped'] = true;                                         // bytes are kept; abort transfer
                return -1;
            }
            return $len;
        },
    ]);
    curl_exec($ch);
    $errno = curl_errno($ch);
    $errmsg = curl_error($ch);
    if ($ctx['status'] === 0) $ctx['status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($ctx['diskError']) return dl_err('disk_write', $ctx['status']);
    if ($ctx['httpError'] === 416) {
        // Range not satisfiable: either the part is already complete, or it is bogus.
        if ($expectedTotal !== null && $offset >= $expectedTotal) {
            return ['ok' => true, 'complete' => true, 'received' => $offset, 'total' => $expectedTotal, 'noRange' => false, 'error' => null, 'status' => 416];
        }
        ftruncate($ctx['fp'], 0);
        return ['ok' => true, 'complete' => false, 'received' => 0, 'total' => $expectedTotal, 'noRange' => false, 'error' => null, 'status' => 416];
    }
    if ($ctx['httpError'] >= 400) return dl_err('http_' . $ctx['httpError'], $ctx['httpError']);
    // errno 23 = write callback abort — expected when we cap a tick.
    if ($errno !== 0 && !($errno === CURLE_WRITE_ERROR && $ctx['capped'])) {
        return dl_err('network:' . ($errmsg ?: ('curl_' . $errno)), $ctx['status']);
    }

    $complete = false;
    if ($ctx['status'] === 206) {
        $complete = $ctx['total'] !== null && ($offset + $ctx['written']) >= $ctx['total'];
    } elseif ($ctx['status'] === 200 && !$ctx['capped']) {
        // Full-body transfer finished cleanly (chunked hosts have no length header).
        $cl = $ctx['contentLength'] ?? null;
        $complete = ($cl === null) || ($ctx['written'] >= $cl);
        if ($ctx['total'] === null && $cl !== null) $ctx['total'] = $cl;
    }
    return ['ok' => true, 'complete' => $complete, 'received' => 0 /* recomputed by caller */,
            'total' => $ctx['total'], 'noRange' => $ctx['noRange'], 'error' => null, 'status' => $ctx['status']];
}

/** Stream (allow_url_fopen) branch of download_tick — manual redirects, budgeted read loop. */
function stream_download_tick(string $url, $fp, int $offset, int $rangeEnd, ?int $expectedTotal): array {
    $redirects = 0;
    while (true) {
        if (!https_only($url)) return dl_err('redirect_not_https', 0);
        $ctxOpts = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => implode("\r\n", [
                    'User-Agent: ' . INSTALLER_UA,
                    'Accept: application/octet-stream',
                    'Range: bytes=' . $offset . '-' . $rangeEnd,
                ]),
                'follow_location' => 0, 'timeout' => CONNECT_TIMEOUT + TICK_SECONDS, 'ignore_errors' => true,
            ],
            'ssl' => ca_stream_opts(),
        ]);
        $in = @fopen($url, 'rb', false, $ctxOpts);
        $meta = isset($http_response_header) && is_array($http_response_header) ? $http_response_header : [];
        [$status, $headers] = parse_response_headers($meta);
        if ($status >= 300 && $status < 400 && isset($headers['location'])) {
            if (is_resource($in)) fclose($in);
            if (++$redirects > MAX_REDIRECTS) return dl_err('too_many_redirects', $status);
            $url = resolve_redirect($url, $headers['location']);
            continue;
        }
        if ($in === false) return dl_err('network', $status);
        break;
    }

    if ($status === 416) {
        fclose($in);
        if ($expectedTotal !== null && $offset >= $expectedTotal) {
            return ['ok' => true, 'complete' => true, 'received' => $offset, 'total' => $expectedTotal, 'noRange' => false, 'error' => null, 'status' => 416];
        }
        ftruncate($fp, 0);
        return ['ok' => true, 'complete' => false, 'received' => 0, 'total' => $expectedTotal, 'noRange' => false, 'error' => null, 'status' => 416];
    }
    if ($status >= 400) { fclose($in); return dl_err('http_' . $status, $status); }

    $total = null;
    if (isset($headers['content-range']) && preg_match('#bytes\s+\d+-\d+/(\d+)#', $headers['content-range'], $m)) $total = (int)$m[1];
    $contentLength = isset($headers['content-length']) ? (int)$headers['content-length'] : null;

    $cap = TICK_BYTES; $deadline = microtime(true) + TICK_SECONDS; $noRange = false;
    if ($status === 200) {
        $noRange = true;
        $cap = MAX_ZIP_BYTES;
        $deadline = microtime(true) + NORANGE_SECONDS;
        if ($offset > 0) { ftruncate($fp, 0); rewind($fp); $offset = 0; }
    }

    $written = 0; $capped = false; $eof = false;
    while (!feof($in)) {
        $chunk = fread($in, 262144);
        if ($chunk === false) break;
        if ($chunk === '') { if (feof($in)) { $eof = true; break; } continue; }
        $w = fwrite($fp, $chunk);
        if ($w !== strlen($chunk)) { fclose($in); return dl_err('disk_write', $status); }
        $written += $w;
        if ($written >= $cap || microtime(true) > $deadline) { $capped = true; break; }
    }
    $eof = $eof || feof($in);
    fclose($in);

    $complete = false;
    if ($status === 206) {
        $complete = $total !== null && ($offset + $written) >= $total;
    } elseif ($status === 200 && $eof && !$capped) {
        $complete = ($contentLength === null) || ($written >= $contentLength);
        if ($total === null && $contentLength !== null) $total = $contentLength;
    }
    return ['ok' => true, 'complete' => $complete, 'received' => 0, 'total' => $total, 'noRange' => $noRange, 'error' => null, 'status' => $status];
}

// ── GitHub release resolution ────────────────────────────────────────────────

/**
 * Verify a detached Ed25519 signature over the SHA256SUMS bytes against the pinned
 * public key, using PHP's built-in libsodium (PHP 7.2+). The signature body may be
 * hex (128 chars) or raw 64-byte binary. Returns false on any malformed input or if
 * sodium is unavailable — fail-closed (the caller refuses the release).
 */
function release_signature_ok(string $sumsBody, string $sigBody): bool {
    if (!function_exists('sodium_crypto_sign_verify_detached')) return false;
    $pkHex = trim(PINNED_PUBKEY);
    if (!preg_match('/^[0-9a-fA-F]{64}$/', $pkHex)) return false;
    $pk = @hex2bin($pkHex);
    if ($pk === false || strlen($pk) !== 32) return false;

    // Canonical form is hex (CI writes sig.hex()); tolerate an exact raw 64-byte
    // binary. Never trim a raw signature — an Ed25519 sig can begin/end with a byte
    // that equals ASCII whitespace, which trim() would corrupt.
    $txt = trim($sigBody);
    if (preg_match('/^[0-9a-fA-F]{128}$/', $txt)) {
        $sig = @hex2bin($txt);
    } elseif (strlen($sigBody) === 64) {
        $sig = $sigBody;
    } else {
        $sig = $txt;
    }
    if (!is_string($sig) || strlen($sig) !== 64) return false;

    try {
        return sodium_crypto_sign_verify_detached($sig, $sumsBody, $pk);
    } catch (\Throwable $e) {
        return false;
    }
}

/**
 * Fetch releases/latest, pick the lumen3d-web-<version>.zip asset (fallback:
 * zipball_url), and resolve the expected sha256 from a SHA256SUMS asset if any.
 * Returns ['ok'=>bool, 'error'=>?, 'retryAfterMin'=>?, 'release'=>?array].
 */
function fetch_release_info(): array {
    $r = http_get_small(GITHUB_API_LATEST, ['Accept: application/vnd.github+json']);
    if ($r['status'] === 403 || $r['status'] === 429) {
        $retryMin = null;
        if (isset($r['headers']['x-ratelimit-reset'])) {
            $retryMin = max(1, (int)ceil(((int)$r['headers']['x-ratelimit-reset'] - time()) / 60));
        } elseif (isset($r['headers']['retry-after'])) {
            $retryMin = max(1, (int)ceil((int)$r['headers']['retry-after'] / 60));
        }
        return ['ok' => false, 'error' => 'rate_limited', 'retryAfterMin' => $retryMin, 'release' => null];
    }
    if ($r['status'] === 404) return ['ok' => false, 'error' => 'no_release', 'retryAfterMin' => null, 'release' => null];
    if (!$r['ok']) {
        // A broken CA store (php.ini pointing at a missing cacert.pem) survived every
        // repair attempt → tell the operator what to fix instead of "check the network".
        $code = is_ca_error($r['error']) ? 'tls_ca_broken' : 'github_unreachable';
        return ['ok' => false, 'error' => $code, 'retryAfterMin' => null, 'release' => null, 'detail' => $r['error'] ?? ('http_' . $r['status'])];
    }

    $rel = json_decode($r['body'], true);
    if (!is_array($rel) || empty($rel['tag_name'])) return ['ok' => false, 'error' => 'github_bad_response', 'retryAfterMin' => null, 'release' => null];

    $tag = (string)$rel['tag_name'];
    $version = ltrim($tag, 'vV');
    $assets = is_array($rel['assets'] ?? null) ? $rel['assets'] : [];

    // Preferred asset: exact lumen3d-web-<version>.zip, else any lumen3d-web-*.zip.
    $asset = null;
    foreach ($assets as $a) {
        if (($a['name'] ?? '') === 'lumen3d-web-' . $version . '.zip') { $asset = $a; break; }
    }
    if ($asset === null) {
        foreach ($assets as $a) {
            if (preg_match('/^lumen3d-web-[0-9][A-Za-z0-9.\-]*\.zip$/', (string)($a['name'] ?? ''))) { $asset = $a; break; }
        }
    }

    $shaAsset = null;
    $sigAsset = null;
    foreach ($assets as $a) {
        $nm = (string)($a['name'] ?? '');
        if ($shaAsset === null && preg_match('/^sha256sums(\.txt)?$/i', $nm)) { $shaAsset = $a; }
        elseif ($sigAsset === null && preg_match('/^sha256sums(\.txt)?\.sig$/i', $nm)) { $sigAsset = $a; }
    }

    $info = [
        'version'   => $version,
        'tag'       => $tag,
        'zipball'   => false,
        'assetName' => null,
        'zipUrl'    => null,
        'size'      => null,
        'sha256'    => null,
        'publishedAt' => (string)($rel['published_at'] ?? ''),
    ];
    if ($asset !== null && !empty($asset['browser_download_url']) && https_only((string)$asset['browser_download_url'])) {
        $info['assetName'] = (string)$asset['name'];
        $info['zipUrl']    = (string)$asset['browser_download_url'];
        $info['size']      = isset($asset['size']) ? (int)$asset['size'] : null;
    } elseif (!empty($rel['zipball_url']) && https_only((string)$rel['zipball_url'])) {
        $info['zipball'] = true;
        $info['zipUrl']  = (string)$rel['zipball_url'];
    } else {
        return ['ok' => false, 'error' => 'no_release_zip', 'retryAfterMin' => null, 'release' => null];
    }
    if ($info['size'] !== null && $info['size'] > MAX_ZIP_BYTES) {
        return ['ok' => false, 'error' => 'too_large', 'retryAfterMin' => null, 'release' => null];
    }

    // Checksums apply to named assets only (a zipball is not listed in SHA256SUMS).
    $info['signingConfigured'] = (PINNED_PUBKEY !== '');
    $info['sigVerified'] = false;
    if ($shaAsset !== null && !$info['zipball'] && !empty($shaAsset['browser_download_url']) && https_only((string)$shaAsset['browser_download_url'])) {
        $sums = http_get_small((string)$shaAsset['browser_download_url']);
        if ($sums['ok']) {
            // Authenticity gate BEFORE trusting any digest from this manifest.
            if (PINNED_PUBKEY !== '') {
                if (!function_exists('sodium_crypto_sign_verify_detached')) {
                    return ['ok' => false, 'error' => 'signature_unsupported', 'retryAfterMin' => null, 'release' => null];
                }
                $sigUrl = ($sigAsset !== null && !empty($sigAsset['browser_download_url'])
                           && https_only((string)$sigAsset['browser_download_url']))
                          ? (string)$sigAsset['browser_download_url'] : null;
                if ($sigUrl === null) {
                    return ['ok' => false, 'error' => 'signature_missing', 'retryAfterMin' => null, 'release' => null];
                }
                $sigResp = http_get_small($sigUrl);
                if (!$sigResp['ok'] || !release_signature_ok($sums['body'], $sigResp['body'])) {
                    return ['ok' => false, 'error' => 'signature_invalid', 'retryAfterMin' => null, 'release' => null];
                }
                $info['sigVerified'] = true;
            }
            foreach (preg_split('/\r?\n/', $sums['body']) as $line) {
                if (preg_match('/^([0-9a-fA-F]{64})\s+\*?(.+)$/', trim($line), $m) && basename(trim($m[2])) === $info['assetName']) {
                    $info['sha256'] = strtolower($m[1]);
                    break;
                }
            }
        } elseif (PINNED_PUBKEY !== '') {
            return ['ok' => false, 'error' => 'signature_invalid', 'retryAfterMin' => null, 'release' => null];
        }
    } elseif (PINNED_PUBKEY !== '') {
        // A key is pinned but the release has no (named-asset) SHA256SUMS to authenticate.
        return ['ok' => false, 'error' => 'signature_missing', 'retryAfterMin' => null, 'release' => null];
    }
    return ['ok' => true, 'error' => null, 'retryAfterMin' => null, 'release' => $info];
}

// ── Requirements ─────────────────────────────────────────────────────────────

/** Environment checklist. $needBytes: expected zip size (disk check wants 2×). */
function requirements_list(?int $needBytes): array {
    $free = @disk_free_space(target_dir());
    $need = ($needBytes !== null ? $needBytes : 100 * 1024 * 1024) * 2;

    // CA trust store: diagnostic only (never blocking) — OpenSSL can hold a default
    // we cannot see from PHP, and open_basedir routinely hides /etc/ssl from is_readable().
    [$caFile, $caDir] = ca_probe();
    $caBroken = ca_ini_broken();
    $caFound = $caFile !== null || $caDir !== null;
    $caOk = (!$caBroken || $caFound) ? true : null;
    $caValue = !$caBroken ? 'php.ini' : ($caFile ?? $caDir);

    return [
        ['id' => 'php',      'ok' => PHP_VERSION_ID >= 70400, 'value' => PHP_VERSION],
        ['id' => 'zip',      'ok' => class_exists('ZipArchive'), 'value' => class_exists('ZipArchive') ? 'ZipArchive' : null],
        ['id' => 'http',     'ok' => http_capable(), 'value' => extension_loaded('curl') ? 'curl' : (http_capable() ? 'allow_url_fopen' : null)],
        ['id' => 'ca',       'ok' => $caOk, 'value' => $caValue, 'hintAlways' => $caOk === null],
        ['id' => 'perms',    'ok' => true, 'value' => sprintf('%04o / %04o', dir_mode(), file_mode()),
         'hintAlways' => perms_owner_split()],
        ['id' => 'crypto',   'ok' => function_exists('hash_pbkdf2') && function_exists('random_bytes') && function_exists('hash_file'), 'value' => 'PBKDF2-SHA256'],
        ['id' => 'writable', 'ok' => is_writable(target_dir()), 'value' => null],
        ['id' => 'disk',     'ok' => ($free === false) ? null : ($free >= $need),
         'value' => ($free === false) ? null : $free, 'need' => $need],
    ];
}

function requirements_pass(array $reqs): bool {
    foreach ($reqs as $r) if ($r['ok'] === false) return false;              // 'null' (unknown) does not block
    return true;
}

/** True when the target dir already holds files beyond the installer's own artifacts. */
function target_dir_not_empty(): bool {
    // cacert.pem (operator override) and the seeded CA bundle are TLS plumbing, not user content.
    $ignore = ['.', '..', 'install.php', 'cacert.pem', CA_SEED_FILE, STATE_FILE, LOCK_FILE, PART_FILE, ZIP_FILE, STATE_FILE . '.tmp'];
    $ls = @scandir(target_dir());
    if ($ls === false) return false;
    foreach ($ls as $f) {
        if (!in_array($f, $ignore, true)) return true;
    }
    return false;
}

// ── Zip validation + extraction ──────────────────────────────────────────────

/** Reject dangerous entry names. Returns an error code or null when safe. */
function entry_name_error(string $name): ?string {
    if ($name === '') return 'empty_name';
    if (strpos($name, "\0") !== false) return 'nul_byte';
    if (strpos($name, '\\') !== false) return 'backslash';
    if ($name[0] === '/') return 'absolute_path';
    if (preg_match('/^[A-Za-z]:/', $name)) return 'drive_letter';
    if (preg_match('/[\x00-\x1F\x7F]/', $name)) return 'control_chars';
    foreach (explode('/', $name) as $seg) {
        if ($seg === '..') return 'traversal';
    }
    return null;
}

/** True when the zip entry at $index is a symlink (unix external attributes). */
function entry_is_symlink(ZipArchive $zip, int $index): bool {
    $opsys = 0; $attr = 0;
    if (!$zip->getExternalAttributesIndex($index, $opsys, $attr)) return false;
    if ($opsys !== ZipArchive::OPSYS_UNIX) return false;
    return ((($attr >> 16) & 0xF000) === 0xA000);                            // S_IFLNK
}

/** Entries that must never be written (self-protection + installer artifacts). */
function is_protected_entry(string $rel): bool {
    if ($rel === 'install.php' || basename($rel) === 'install.php') return true;
    return in_array($rel, [STATE_FILE, LOCK_FILE, PART_FILE, ZIP_FILE], true);
}

/**
 * The release archive is universal (Python + PHP hosts). install.php only ever
 * runs on a PHP host, so the Python dev servers, the Python-only Ed25519 verifier
 * and the Windows launcher have no place in the deployed web root — they are dead
 * weight and needlessly expose server-side source. The PHP host serves HTML via
 * _serve.php/router.php and verifies signatures with libsodium, so none of these
 * are used. (Kept: router.php/_serve.php/.htaccess/api + LICENCE.)
 */
function is_php_host_skip(string $rel): bool {
    static $skip = [
        'dev_server.py'   => true,   // Python dev/admin server — not runnable on PHP hosting
        'fast_server.py'  => true,   // Python static server
        'ed25519_pure.py' => true,   // Python signature verifier (PHP uses libsodium)
        'start.bat'       => true,   // Windows launcher
    ];
    return isset($skip[$rel]);
}

/**
 * If every entry lives under a single top-level directory (GitHub zipball
 * layout: nutchaxo-lumen3D-<sha>/...), return that "dir/" prefix to strip.
 */
function common_root_dir(ZipArchive $zip): string {
    $root = null;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string)$zip->getNameIndex($i);
        if ($name === '') continue;
        $pos = strpos($name, '/');
        if ($pos === false) return '';                                       // top-level file → nothing to strip
        $seg = substr($name, 0, $pos);
        if ($root === null) $root = $seg;
        elseif ($seg !== $root) return '';
    }
    return $root === null ? '' : $root . '/';
}

/**
 * Full pre-extraction validation of the archive: entry count cap, per-entry
 * name safety, symlink census, total uncompressed size cap, root prefix.
 * Returns ['ok','error'=>?,'detail'=>?,'entries','totalUncompressed','stripPrefix','symlinks'].
 */
function zip_preflight(string $zipPath): array {
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) return ['ok' => false, 'error' => 'zip_open_failed'];
    if ($zip->numFiles === 0) { $zip->close(); return ['ok' => false, 'error' => 'zip_empty']; }
    if ($zip->numFiles > MAX_ENTRIES) { $zip->close(); return ['ok' => false, 'error' => 'too_many_entries']; }

    $total = 0; $symlinks = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $st = $zip->statIndex($i);
        if ($st === false) { $zip->close(); return ['ok' => false, 'error' => 'zip_stat_failed', 'detail' => 'index ' . $i]; }
        $err = entry_name_error((string)$st['name']);
        if ($err !== null) { $zip->close(); return ['ok' => false, 'error' => 'zip_bad_entry', 'detail' => $err . ': ' . substr((string)$st['name'], 0, 120)]; }
        if (entry_is_symlink($zip, $i)) $symlinks++;
        $total += (int)$st['size'];
        if ($total > MAX_TOTAL_UNCOMPRESSED) { $zip->close(); return ['ok' => false, 'error' => 'too_large_uncompressed']; }
    }
    $prefix = common_root_dir($zip);
    $entries = $zip->numFiles;
    $zip->close();
    return ['ok' => true, 'error' => null, 'entries' => $entries, 'totalUncompressed' => $total, 'stripPrefix' => $prefix, 'symlinks' => $symlinks];
}

/**
 * Extract one entry via getStream with per-entry validation. Never follows or
 * creates symlinks; never overwrites install.php. Throws RuntimeException on
 * hard failures (message = error code shown in the UI).
 * Returns bytes written (0 for dirs/skips). $skipped set true when not extracted.
 */
function extract_entry(ZipArchive $zip, int $index, string $stripPrefix, ?bool &$skipped): int {
    $skipped = false;
    $st = $zip->statIndex($index);
    if ($st === false) throw new RuntimeException('zip_stat_failed');
    $name = (string)$st['name'];

    $err = entry_name_error($name);                                          // defense in depth (re-check)
    if ($err !== null) throw new RuntimeException('zip_bad_entry:' . $err);
    if (entry_is_symlink($zip, $index)) { $skipped = true; return 0; }       // symlinks rejected

    $rel = $name;
    if ($stripPrefix !== '' && strncmp($rel, $stripPrefix, strlen($stripPrefix)) === 0) {
        $rel = substr($rel, strlen($stripPrefix));
    }
    if ($rel === '' || is_protected_entry($rel) || is_php_host_skip($rel)) { $skipped = true; return 0; }

    $dest = tpath($rel);
    if (substr($name, -1) === '/') {                                         // directory entry
        if (!make_dir($dest)) throw new RuntimeException('mkdir_failed');
        if (!within_target($dest)) throw new RuntimeException('zip_bad_entry:escape');
        return 0;
    }

    $dir = dirname($dest);
    if (!make_dir($dir)) throw new RuntimeException('mkdir_failed');
    if (!within_target($dir)) throw new RuntimeException('zip_bad_entry:escape');
    // Never allow an entry to resolve onto this installer file itself.
    $selfReal = realpath(__FILE__);
    if ($selfReal !== false && is_file($dest) && realpath($dest) === $selfReal) { $skipped = true; return 0; }

    $in = $zip->getStream($name);
    if ($in === false) throw new RuntimeException('zip_entry_read');
    $out = @fopen($dest, 'wb');                                              // 'wb' truncates any partial from a prior crash
    if ($out === false) { fclose($in); throw new RuntimeException('file_write_open'); }

    $declared = (int)$st['size'];
    $written = 0;
    while (!feof($in)) {
        $chunk = fread($in, 262144);
        if ($chunk === false) { fclose($in); fclose($out); throw new RuntimeException('zip_entry_read'); }
        if ($chunk === '') continue;
        $w = fwrite($out, $chunk);
        if ($w !== strlen($chunk)) { fclose($in); fclose($out); throw new RuntimeException('disk_write'); }
        $written += $w;
        if ($written > $declared + 65536) { fclose($in); fclose($out); @unlink($dest); throw new RuntimeException('zip_entry_overflow'); }
    }
    fclose($in);
    fclose($out);
    fix_file_mode($dest);
    return $written;
}

// ── API handlers ─────────────────────────────────────────────────────────────

function state_summary(?array $s): array {
    if ($s === null) return ['phase' => null];
    return [
        'phase'          => $s['phase'],
        'release'        => [
            'version' => $s['release']['version'] ?? null,
            'size'    => $s['release']['size'] ?? null,
            'zipball' => $s['release']['zipball'] ?? false,
            'sha256'  => isset($s['release']['sha256']) && $s['release']['sha256'] !== null,
        ],
        'received'       => $s['received'] ?? 0,
        'extractedIndex' => $s['extractedIndex'] ?? 0,
        'entriesTotal'   => $s['entriesTotal'] ?? null,
        'noRange'        => $s['noRange'] ?? false,
        'startedAt'      => $s['startedAt'] ?? null,
    ];
}

function handle_status(): void {
    json_out(['ok' => true, 'locked' => is_locked(), 'state' => state_summary(read_state())]);
}

/** Requirements + latest-release lookup; (re)initializes state when needed. */
function handle_check(): void {
    $existing = read_state();
    $rel = http_capable() ? fetch_release_info() : ['ok' => false, 'error' => 'no_http_capability', 'retryAfterMin' => null, 'release' => null];
    $reqs = requirements_list($rel['ok'] ? ($rel['release']['size'] ?? null) : null);

    if (!$rel['ok']) {
        // ok:true so the UI can render the checklist with the release error inline.
        json_out([
            'ok' => true,
            'requirements' => $reqs, 'requirementsPass' => requirements_pass($reqs),
            'dirNotEmpty' => target_dir_not_empty(),
            'releaseError' => ['code' => $rel['error'], 'retryAfterMin' => $rel['retryAfterMin'], 'detail' => $rel['detail'] ?? null],
            'release' => null,
            'state' => state_summary($existing),
        ]);
    }

    $release = $rel['release'];
    $sameInstall = $existing !== null && ($existing['release']['version'] ?? null) === $release['version']
        && ($existing['release']['zipUrl'] ?? null) === $release['zipUrl'];
    if (!$sameInstall) {
        clear_artifacts(false);                                              // stale artifacts from another version
        $existing = [
            'phase' => 'ready',
            'release' => $release,
            'received' => 0,
            'extractedIndex' => 0,
            'entriesTotal' => null,
            'bytesWritten' => 0,
            'stripPrefix' => '',
            'noRange' => false,
            'startedAt' => date('c'),
        ];
    } else {
        $existing['release'] = $release;                                     // refresh URLs (asset links can rotate)
    }
    if (!write_state($existing)) json_fail('state_write_failed', 500);

    json_out([
        'ok' => true,
        'requirements' => $reqs, 'requirementsPass' => requirements_pass($reqs),
        'dirNotEmpty' => target_dir_not_empty(),
        'release' => [
            'version' => $release['version'], 'tag' => $release['tag'],
            'assetName' => $release['assetName'], 'zipball' => $release['zipball'],
            'size' => $release['size'], 'hasSha256' => $release['sha256'] !== null,
            'publishedAt' => $release['publishedAt'],
            'signingConfigured' => $release['signingConfigured'] ?? false,
            'sigVerified' => $release['sigVerified'] ?? false,
        ],
        'state' => state_summary($existing),
    ]);
}

/** One download tick; promotes .part → .zip when complete. */
function handle_download(): void {
    $s = require_state(['ready', 'downloading', 'downloaded']);
    if ($s['phase'] === 'downloaded' && is_file(tpath(ZIP_FILE))) {
        json_out(['ok' => true, 'done' => true, 'received' => (int)filesize(tpath(ZIP_FILE)), 'total' => $s['release']['size'], 'pct' => 100]);
    }
    $url = (string)($s['release']['zipUrl'] ?? '');
    if ($url === '') json_fail('no_state', 409);
    $expected = isset($s['release']['size']) && $s['release']['size'] !== null ? (int)$s['release']['size'] : null;

    $res = download_tick($url, tpath(PART_FILE), $expected);
    if (!$res['ok']) {
        if ($res['error'] === 'http_403' || $res['error'] === 'http_429') json_fail('rate_limited', 200, ['retryAfterMin' => null]);
        json_fail((string)$res['error'], 200);
    }

    $s['phase'] = 'downloading';
    $s['received'] = $res['received'];
    $s['noRange'] = $s['noRange'] || $res['noRange'];
    if ($res['total'] !== null && ($s['release']['size'] ?? null) === null) $s['release']['size'] = $res['total'];

    $done = false;
    if ($res['complete']) {
        $zipPath = tpath(ZIP_FILE);
        if (is_file($zipPath)) @unlink($zipPath);
        if (!@rename(tpath(PART_FILE), $zipPath)) json_fail('disk_write', 500);
        $s['phase'] = 'downloaded';
        $done = true;
    }
    if (!write_state($s)) json_fail('state_write_failed', 500);

    $total = $s['release']['size'];
    json_out([
        'ok' => true, 'done' => $done,
        'received' => $s['received'], 'total' => $total,
        'pct' => ($total !== null && $total > 0) ? min(100, (int)floor($s['received'] * 100 / $total)) : null,
        'noRange' => $s['noRange'],
    ]);
}

/**
 * Phase-aware verification.
 *  - 'downloaded'  → verify the archive BEFORE any extraction: size, sha256
 *                    (hard fail on mismatch), structural preflight. → 'verified'
 *  - 'extracted'   → verify the installation: key files present, entry count. → 'installed'
 */
function handle_verify(): void {
    $s = require_state(['downloaded', 'verified', 'extracted', 'installed']);
    $warnings = [];

    if ($s['phase'] === 'downloaded' || $s['phase'] === 'verified') {
        if ($s['phase'] === 'verified') json_out(['ok' => true, 'stage' => 'archive', 'warnings' => [], 'entries' => $s['entriesTotal']]);
        $zipPath = tpath(ZIP_FILE);
        if (!is_file($zipPath)) { $s['phase'] = 'ready'; $s['received'] = 0; write_state($s); json_fail('zip_missing', 200); }

        $size = (int)filesize($zipPath);
        $expected = $s['release']['size'] ?? null;
        if ($expected !== null && $size !== (int)$expected) {                // wrong-size zip → restart download
            @unlink($zipPath);
            $s['phase'] = 'ready'; $s['received'] = 0;
            write_state($s);
            json_fail('size_mismatch', 200);
        }
        $expectedSha = $s['release']['sha256'] ?? null;
        if ($expectedSha !== null) {
            @set_time_limit(120);
            $actual = hash_file('sha256', $zipPath);
            if (!is_string($actual) || !hash_equals(strtolower($expectedSha), strtolower($actual))) {
                @unlink($zipPath);                                           // corrupted/tampered → never extract
                $s['phase'] = 'ready'; $s['received'] = 0;
                write_state($s);
                json_fail('sha256_mismatch', 200);
            }
        } else {
            $warnings[] = 'no_checksum';                                     // proceed, but surface it
        }

        $pf = zip_preflight($zipPath);
        if (!$pf['ok']) {
            json_fail((string)$pf['error'], 200, ['detail' => $pf['detail'] ?? null]);
        }
        if ($pf['symlinks'] > 0) $warnings[] = 'symlinks_skipped';
        $s['phase'] = 'verified';
        $s['entriesTotal'] = $pf['entries'];
        $s['stripPrefix'] = $pf['stripPrefix'];
        $s['extractedIndex'] = 0;
        $s['bytesWritten'] = 0;
        if (!write_state($s)) json_fail('state_write_failed', 500);
        json_out(['ok' => true, 'stage' => 'archive', 'warnings' => $warnings, 'entries' => $pf['entries'], 'sha256Verified' => $expectedSha !== null]);
    }

    // Post-extraction verification.
    if ($s['phase'] === 'installed') json_out(['ok' => true, 'stage' => 'install', 'warnings' => []]);
    if (!is_file(tpath('index.html'))) json_fail('install_incomplete', 200, ['detail' => 'index.html missing']);
    if (!is_file(tpath('version.json'))) $warnings[] = 'no_version_json';
    if (($s['extractedIndex'] ?? 0) < (int)($s['entriesTotal'] ?? 0)) json_fail('install_incomplete', 200, ['detail' => 'entry count mismatch']);
    $s['phase'] = 'installed';
    if (!write_state($s)) json_fail('state_write_failed', 500);
    json_out(['ok' => true, 'stage' => 'install', 'warnings' => $warnings]);
}

/** One extraction tick: up to EXTRACT_BATCH validated entries or EXTRACT_SECONDS. */
function handle_extract(): void {
    $s = require_state(['verified', 'extracting', 'extracted']);
    if ($s['phase'] === 'extracted') {
        json_out(['ok' => true, 'done' => true, 'index' => $s['extractedIndex'], 'total' => $s['entriesTotal'], 'pct' => 100]);
    }
    $zipPath = tpath(ZIP_FILE);
    if (!is_file($zipPath)) { $s['phase'] = 'ready'; $s['received'] = 0; write_state($s); json_fail('zip_missing', 200); }
    @set_time_limit(EXTRACT_SECONDS + 60);

    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) json_fail('zip_open_failed', 200);
    $total = $zip->numFiles;
    if ($total !== (int)$s['entriesTotal']) { $zip->close(); json_fail('zip_changed', 200); }

    $i = (int)$s['extractedIndex'];
    $deadline = microtime(true) + EXTRACT_SECONDS;
    $batch = 0;
    $skippedCount = 0;
    try {
        while ($i < $total && $batch < EXTRACT_BATCH && microtime(true) < $deadline) {
            $skipped = false;
            $bytes = extract_entry($zip, $i, (string)$s['stripPrefix'], $skipped);
            if ($skipped) $skippedCount++;
            $s['bytesWritten'] = (int)($s['bytesWritten'] ?? 0) + $bytes;
            if ($s['bytesWritten'] > MAX_TOTAL_UNCOMPRESSED) throw new RuntimeException('too_large_uncompressed');
            $i++;                                                            // only after the entry fully landed
            $batch++;
        }
    } catch (RuntimeException $e) {
        $zip->close();
        $s['phase'] = 'extracting';
        $s['extractedIndex'] = $i;                                           // resume retries this entry from scratch
        write_state($s);
        json_fail($e->getMessage(), 200, ['index' => $i, 'total' => $total]);
    }
    $zip->close();

    $s['phase'] = ($i >= $total) ? 'extracted' : 'extracting';
    $s['extractedIndex'] = $i;
    if (!write_state($s)) json_fail('state_write_failed', 500);
    json_out([
        'ok' => true, 'done' => $i >= $total,
        'index' => $i, 'total' => $total,
        'pct' => $total > 0 ? (int)floor($i * 100 / $total) : 100,
        'skipped' => $skippedCount,
    ]);
}

/** Admin account creation (create-exclusive) + data dirs + api/.htaccess if missing. */
function handle_configure(): void {
    // White-label: the installer no longer creates the admin account — it only
    // prepares the infrastructure (api/.htaccess + data dirs). The platform's guided
    // setup wizard creates the account + identity + theme + plugins on the FIRST VISIT
    // (needsSetup stays true while api/admin_credential.json is absent).
    $s = require_state(['installed', 'configured']);
    if ($s['phase'] === 'configured') {
        json_out(['ok' => true, 'already' => true]);
    }

    $apiDir = tpath('api');
    if (!make_dir($apiDir)) json_fail('mkdir_failed', 500);

    // api/.htaccess: only create when the release zip did not ship one.
    $ht = $apiDir . '/.htaccess';
    if (!file_exists($ht)) {
        // Deny EVERY api/*.json (credential/stats/plugin toggles/quarantine/trust
        // store) + the shared PHP include — matches the shipped api/.htaccess so a
        // fallback-created file can't leave plugin-trust.json web-readable.
        $rules = "# Lumen3D — protect admin state files (created by install.php)\n"
            . "<FilesMatch \"\\.json$|^_admin_lib\\.php$\">\n"
            . "    <IfModule mod_authz_core.c>\n        Require all denied\n    </IfModule>\n"
            . "    <IfModule !mod_authz_core.c>\n        Order allow,deny\n        Deny from all\n    </IfModule>\n"
            . "</FilesMatch>\n";
        if (file_put_contents($ht, $rules) === false) json_fail('htaccess_write_failed', 500);
        fix_file_mode($ht);
    }

    // Data layout (only create what is absent — never touch existing data).
    // These are the directories the operator uploads datasets into over SFTP, so
    // getting their mode right matters more here than anywhere else.
    foreach (['DATA_WEB', 'DATA_WEB/fixed', 'DATA_WEB/live', 'DATA_WEB/tracking'] as $d) {
        $p = tpath($d);
        if (!make_dir($p)) json_fail('mkdir_failed', 500);
    }
    $catalog = tpath('DATA_WEB/catalog.json');
    if (!file_exists($catalog)) {
        if (file_put_contents($catalog, json_encode(['datasets' => []])) === false) json_fail('catalog_write_failed', 500);
    }
    fix_file_mode($catalog);

    $s['phase'] = 'configured';
    if (!write_state($s)) json_fail('state_write_failed', 500);
    json_out(['ok' => true]);
}

/** Write .install-lock, remove installer working files. */
function handle_finalize(): void {
    $s = require_state(['configured']);
    $lock = json_encode(['installedAt' => date('c'), 'version' => $s['release']['version'] ?? null]);
    if (file_put_contents(tpath(LOCK_FILE), $lock) === false) json_fail('lock_write_failed', 500);
    fix_file_mode(tpath(LOCK_FILE));
    // The release ships api/ca-bundle.pem from v1.23.0 on; once it is there the
    // installer's seed is redundant. Older releases keep it — it is their only store.
    if (is_readable(tpath('api/ca-bundle.pem'))) @unlink(tpath(CA_SEED_FILE));
    [$fixed, $failed] = apply_tree_modes();                                  // last-mile guarantee
    clear_artifacts(true);
    $leftover = is_file(tpath(STATE_FILE));
    json_out(['ok' => true, 'stateCleared' => !$leftover, 'permsFixed' => $fixed, 'permsFailed' => $failed]);
}

/** Wipe installer working files so the user can restart from zero. */
function handle_reset(): void {
    clear_artifacts(true);
    json_out(['ok' => true]);
}

/** CSRF-checked self-deletion of install.php. */
function handle_selfdelete(): void {
    $ok = @unlink(__FILE__);
    clearstatcache(true, __FILE__);
    if ($ok && !file_exists(__FILE__)) json_out(['ok' => true]);
    json_fail('selfdelete_failed', 200);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

install_session();

$api = isset($_GET['api']) ? (string)$_GET['api'] : null;
if ($api !== null) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') json_fail('method_not_allowed', 405);
    if (!check_csrf()) json_fail('csrf', 403);
    if (is_locked() && !in_array($api, ['status', 'selfdelete'], true)) json_fail('locked', 423);
    switch ($api) {
        case 'status':     handle_status();     break;
        case 'check':      handle_check();      break;
        case 'download':   handle_download();   break;
        case 'extract':    handle_extract();    break;
        case 'verify':     handle_verify();     break;
        case 'configure':  handle_configure();  break;
        case 'finalize':   handle_finalize();   break;
        case 'reset':      handle_reset();      break;
        case 'selfdelete': handle_selfdelete(); break;
        default:           json_fail('unknown_api', 400);
    }
    exit;                                                                    // handlers exit; keep analyzers happy
}

render_page();

// ── UI page (GET) — self-contained, no external requests ────────────────────

function render_page(): void {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, no-cache');
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: no-referrer');

    $boot = [
        'locked'       => is_locked(),
        'lockedReason' => file_exists(tpath(LOCK_FILE)) ? 'lock' : (file_exists(credential_path()) ? 'credential' : null),
        'state'        => state_summary(read_state()),
        'hasIndex'     => is_file(tpath('index.html')),
    ];
    $csrf = csrf_token();
    $html = page_template();
    echo str_replace(
        ['{{CSRF}}', '{{BOOT}}'],
        [htmlspecialchars($csrf, ENT_QUOTES, 'UTF-8'),
         json_encode($boot, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT)],
        $html
    );
}

/** The full HTML document (nowdoc: no PHP interpolation — placeholders only). */
function page_template(): string {
    return <<<'HTML'
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Lumen3D — Installation</title>
<style>
:root{
  --bg:#0b0e14; --card:#131720; --card-2:#1a1f2b; --border:#242b3a;
  --text:#e6eaf2; --muted:#8b93a7; --faint:#5b6375;
  --accent:#4f8cff; --accent-2:#2f6ae0; --success:#34d399; --error:#f87171; --warn:#fbbf24;
  --radius:12px; --radius-s:8px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f2f4f8; --card:#ffffff; --card-2:#f6f8fb; --border:#dfe4ec;
    --text:#1a2233; --muted:#5b6577; --faint:#98a1b3;
    --accent:#2f6ae0; --accent-2:#1f54c0; --success:#0e9f6e; --error:#dc2626; --warn:#b45309;
  }
}
*{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px}
body{
  background:var(--bg); color:var(--text); font-family:var(--font);
  min-height:100vh; display:flex; flex-direction:column; align-items:center;
  padding:2rem 1rem; line-height:1.5;
  background-image:radial-gradient(ellipse 60% 40% at 50% -10%, rgba(79,140,255,.08), transparent);
}
.wrap{width:100%;max-width:560px;display:flex;flex-direction:column;gap:.9rem;flex:1}
.topbar{display:flex;justify-content:flex-end}
.lang-btn{
  background:var(--card);border:1px solid var(--border);color:var(--muted);
  border-radius:999px;padding:.3rem .85rem;font-size:.8rem;font-weight:600;cursor:pointer;
  transition:color .15s,border-color .15s;
}
.lang-btn:hover,.lang-btn:focus-visible{color:var(--text);border-color:var(--accent)}
.card{
  background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
  padding:1.75rem;box-shadow:0 12px 40px rgba(0,0,0,.25);
}
.brand{display:flex;align-items:center;gap:.8rem;margin-bottom:1.4rem}
.brand svg{flex:none}
.brand h1{font-size:1.25rem;font-weight:700;letter-spacing:.01em}
.brand h1 span{color:var(--muted);font-weight:400}
.stepper{display:flex;list-style:none;gap:.25rem;margin-bottom:1.5rem}
.stepper li{
  flex:1;display:flex;flex-direction:column;align-items:center;gap:.35rem;
  font-size:.68rem;color:var(--faint);text-align:center;position:relative;
}
.stepper li::before{
  content:attr(data-n);width:1.7rem;height:1.7rem;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:600;
  background:var(--card-2);border:1px solid var(--border);color:var(--muted);
  transition:background .25s,border-color .25s,color .25s;
}
.stepper li.active{color:var(--text)}
.stepper li.active::before{background:var(--accent);border-color:var(--accent);color:#fff}
.stepper li.done{color:var(--muted)}
.stepper li.done::before{content:"\2713";background:transparent;border-color:var(--success);color:var(--success)}
#view{min-height:180px}
h2{font-size:1.05rem;font-weight:650;margin-bottom:.35rem}
p.sub{color:var(--muted);font-size:.88rem;margin-bottom:1.1rem}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:.4rem;
  font:inherit;font-size:.9rem;font-weight:600;border-radius:var(--radius-s);
  padding:.6rem 1.15rem;cursor:pointer;border:1px solid transparent;
  transition:background .15s,border-color .15s,opacity .15s;
}
.btn:disabled{opacity:.5;cursor:default}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--accent-2)}
.btn-ghost{background:transparent;color:var(--muted);border-color:var(--border)}
.btn-ghost:hover:not(:disabled){color:var(--text);border-color:var(--accent)}
.btn-danger{background:transparent;color:var(--error);border-color:var(--error)}
.btn-danger:hover:not(:disabled){background:var(--error);color:#fff}
.actions{display:flex;gap:.6rem;margin-top:1.25rem;flex-wrap:wrap}
.req-list{list-style:none;display:flex;flex-direction:column;gap:.4rem;margin:.8rem 0}
.req-list li{
  display:flex;align-items:baseline;gap:.6rem;font-size:.86rem;
  background:var(--card-2);border:1px solid var(--border);border-radius:var(--radius-s);
  padding:.5rem .75rem;
}
.req-ic{font-weight:700;width:1rem;flex:none}
.req-ok .req-ic{color:var(--success)}
.req-bad .req-ic{color:var(--error)}
.req-unk .req-ic{color:var(--warn)}
.req-name{flex:1}
.req-val{color:var(--muted);font-size:.78rem;font-family:var(--mono)}
.req-hint{display:block;color:var(--error);font-size:.76rem;margin-top:.15rem}
.release-box{
  display:flex;justify-content:space-between;align-items:center;gap:.75rem;
  background:var(--card-2);border:1px solid var(--border);border-radius:var(--radius-s);
  padding:.7rem .9rem;margin:.9rem 0 .2rem;font-size:.86rem;
}
.release-box .ver{font-weight:700;font-family:var(--mono);color:var(--accent)}
.release-box .meta{color:var(--muted);font-size:.76rem}
.progress-wrap{margin:1.1rem 0 .4rem}
.progress-label{display:flex;justify-content:space-between;font-size:.82rem;color:var(--muted);margin-bottom:.4rem}
.progress-label .pct{font-family:var(--mono);color:var(--text)}
.progress{
  height:8px;border-radius:999px;background:var(--card-2);border:1px solid var(--border);overflow:hidden;
}
.progress > div{
  height:100%;width:0%;border-radius:999px;
  background:linear-gradient(90deg,var(--accent),#7fb0ff);
  transition:width .3s ease;
}
.progress.indeterminate > div{width:35%;animation:slide 1.4s ease-in-out infinite}
@keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
.banner{
  display:flex;gap:.6rem;align-items:flex-start;font-size:.84rem;
  border-radius:var(--radius-s);padding:.65rem .85rem;margin-bottom:1rem;border:1px solid;
}
.banner-info{border-color:var(--accent);background:rgba(79,140,255,.08);color:var(--text)}
.banner-warn{border-color:var(--warn);background:rgba(251,191,36,.08);color:var(--text)}
.banner-error{border-color:var(--error);background:rgba(248,113,113,.08);color:var(--text)}
.banner-ok{border-color:var(--ok,#34d399);background:rgba(52,211,153,.10);color:var(--text)}
.banner b{display:block;font-size:.86rem}
.banner .bicon{flex:none;font-weight:700}
.banner-warn .bicon{color:var(--warn)}
.banner-error .bicon{color:var(--error)}
.banner-info .bicon{color:var(--accent)}
.banner-ok .bicon{color:var(--ok,#34d399)}
form .field{margin-bottom:1rem}
label{display:block;font-size:.82rem;font-weight:600;color:var(--muted);margin-bottom:.35rem}
input[type=text],input[type=password]{
  width:100%;font:inherit;font-size:.92rem;color:var(--text);
  background:var(--card-2);border:1px solid var(--border);border-radius:var(--radius-s);
  padding:.55rem .75rem;transition:border-color .15s;
}
input:focus{outline:none;border-color:var(--accent)}
.strength{display:flex;align-items:center;gap:.6rem;margin-top:.4rem}
.strength .bars{display:flex;gap:3px;flex:none}
.strength .bars i{width:26px;height:4px;border-radius:2px;background:var(--border);transition:background .2s}
.strength.s1 .bars i:nth-child(-n+1){background:var(--error)}
.strength.s2 .bars i:nth-child(-n+2){background:var(--warn)}
.strength.s3 .bars i:nth-child(-n+3){background:var(--success)}
.strength.s4 .bars i{background:var(--success)}
.strength .txt{font-size:.75rem;color:var(--muted)}
.final-links{display:flex;gap:.6rem;margin:1rem 0;flex-wrap:wrap}
.final-links a{
  flex:1;min-width:140px;text-align:center;text-decoration:none;
  background:var(--card-2);border:1px solid var(--border);border-radius:var(--radius-s);
  color:var(--text);padding:.7rem;font-size:.88rem;font-weight:600;transition:border-color .15s;
}
.final-links a:hover,.final-links a:focus-visible{border-color:var(--accent)}
.final-links a span{display:block;color:var(--muted);font-size:.74rem;font-weight:400}
.checkmark{
  width:52px;height:52px;border-radius:50%;margin:0 auto 1rem;
  display:flex;align-items:center;justify-content:center;
  background:rgba(52,211,153,.12);color:var(--success);font-size:1.6rem;font-weight:700;
}
.center{text-align:center}
.foot{color:var(--faint);font-size:.74rem;text-align:center;padding:.75rem 0}
.detail{font-family:var(--mono);font-size:.74rem;color:var(--muted);word-break:break-all;margin-top:.3rem}
.fade-in{animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
a.plain{color:var(--accent)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <button type="button" class="lang-btn" id="langBtn" aria-label="Switch language">EN</button>
  </div>
  <main class="card" aria-labelledby="brandTitle">
    <header class="brand">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect x="5" y="9" width="18" height="18" rx="3" stroke="var(--accent)" stroke-width="2"/>
        <path d="M23 13l8-5v18l-8-5" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" fill="rgba(79,140,255,.15)"/>
        <circle cx="14" cy="18" r="3.5" fill="var(--accent)" opacity=".85"/>
        <circle cx="14" cy="18" r="6.5" stroke="var(--accent)" stroke-width="1" opacity=".35"/>
      </svg>
      <h1 id="brandTitle">Lumen3D <span data-i18n="title_suffix">— Installation</span></h1>
    </header>
    <ol class="stepper" id="stepper" aria-hidden="true">
      <li data-n="1" data-i18n="step1">Prérequis</li>
      <li data-n="2" data-i18n="step2">Téléchargement</li>
      <li data-n="3" data-i18n="step3">Installation</li>
      <li data-n="4" data-i18n="step4">Compte admin</li>
      <li data-n="5" data-i18n="step5">Terminé</li>
    </ol>
    <section id="view" aria-live="polite"></section>
    <noscript><p data-i18n="noscript">JavaScript est requis pour exécuter l'installateur.</p></noscript>
  </main>
  <footer class="foot">IRIBHM — Université Libre de Bruxelles · <span id="footNote">Lumen3D installer</span></footer>
</div>
<script>
'use strict';
const CSRF = "{{CSRF}}";
const BOOT = {{BOOT}};

/* ── i18n ─────────────────────────────────────────────────────────────────── */
const DICT = {
  fr: {
    title_suffix: "— Installation",
    noscript: "JavaScript est requis pour exécuter l'installateur.",
    step1: "Prérequis", step2: "Téléchargement", step3: "Installation", step4: "Compte admin", step5: "Terminé",
    welcome_title: "Bienvenue",
    welcome_sub: "Cet assistant télécharge la dernière version de Lumen3D depuis GitHub, l'installe dans ce dossier et configure le compte administrateur. Rien n'est écrit avant que l'archive soit entièrement vérifiée.",
    btn_start: "Commencer l'installation",
    resume_title: "Installation en cours détectée",
    resume_text: "Une installation de la version {v} a été interrompue. Vous pouvez la reprendre là où elle s'est arrêtée.",
    btn_resume: "Reprendre l'installation", btn_restart: "Recommencer à zéro",
    req_title: "Vérification de l'environnement",
    req_sub: "L'installateur vérifie que cet hébergement peut exécuter Lumen3D.",
    req_checking: "Vérification en cours…",
    req_php: "PHP ≥ 7.4", req_zip: "Extension Zip (ZipArchive)", req_http: "Accès HTTPS sortant (curl ou allow_url_fopen)",
    req_crypto: "Fonctions cryptographiques (PBKDF2)", req_writable: "Dossier accessible en écriture", req_disk: "Espace disque libre",
    req_ca: "Certificats CA (vérification HTTPS)",
    hint_ca: "Aucun magasin utilisable et le trousseau intégré n'a pas pu être écrit (dossier en lecture seule ?). Rendez le dossier inscriptible, ou téléversez cacert.pem (https://curl.se/ca/cacert.pem) à côté de install.php.",
    req_perms: "Permissions des fichiers créés (dossiers / fichiers)",
    hint_perms: "PHP tourne sous un utilisateur différent du propriétaire du site : les fichiers créés sont rendus inscriptibles pour rester modifiables via FTP/SFTP.",
    hint_php: "Mettez à jour PHP via le panneau de votre hébergeur.",
    hint_zip: "Activez l'extension « zip » dans la configuration PHP.",
    hint_http: "Activez l'extension curl ou allow_url_fopen dans php.ini.",
    hint_crypto: "Les extensions hash / openssl standard sont requises.",
    hint_writable: "Donnez les droits d'écriture au dossier (chmod 755 / propriétaire correct).",
    hint_disk: "Libérez de l'espace : il faut environ 2× la taille de l'archive.",
    disk_unknown: "impossible à mesurer",
    dir_not_empty: "Ce dossier n'est pas vide. Les fichiers existants ne seront jamais supprimés — seuls les fichiers de la release vérifiée seront écrits (écrasement possible).",
    release_label: "Dernière version",
    release_asset: "archive de release", release_zipball: "archive du dépôt (zipball)",
    release_no_sha: "Aucun fichier SHA256SUMS dans la release : l'intégrité ne pourra pas être vérifiée par empreinte.",
    release_sig_ok: "Signature d'authenticité vérifiée (Ed25519) : cette archive provient bien de la clé de signature du projet.",
    btn_install: "Installer la version {v}", btn_recheck: "Réessayer",
    dl_title: "Téléchargement", dl_sub: "L'archive est téléchargée par tranches et peut reprendre après une coupure.",
    dl_progress: "Téléchargement {got} / {total} Mo", dl_progress_nototal: "Téléchargement {got} Mo",
    dl_norange: "Cet hébergeur ne permet pas la reprise par plage d'octets : téléchargement en un seul passage.",
    vf_title: "Vérification de l'archive", vf_text: "Contrôle de la taille, de l'empreinte SHA-256 et de la structure du zip…",
    vf_sha_ok: "Empreinte SHA-256 vérifiée.",
    warn_no_checksum: "Empreinte SHA-256 indisponible pour cette release — l'archive n'a pas pu être vérifiée par checksum (avertissement, l'installation continue).",
    warn_symlinks: "Des liens symboliques présents dans l'archive ont été ignorés par sécurité.",
    ex_title: "Installation des fichiers", ex_sub: "Chaque entrée du zip est validée individuellement avant écriture.",
    ex_progress: "Extraction {i} / {n} fichiers",
    vi_text: "Vérification de l'installation…",
    warn_no_version_json: "version.json absent de la release (les mises à jour automatiques pourraient ne pas le détecter).",
    cfg_title: "Préparer l'installation",
    cfg_sub: "Cette étape prépare les dossiers de données et la protection de api/. Le compte administrateur, l'identité (nom, logo, textes), le thème et les plugins se créent au premier lancement de la plateforme, via l'assistant guidé.",
    cfg_account_note: "Aucun compte n'est créé maintenant. À la première ouverture du panneau d'administration, un assistant vous guidera pour créer votre compte et personnaliser la plateforme.",
    cfg_user: "Nom d'utilisateur", cfg_user_ph: "admin",
    cfg_pass: "Mot de passe", cfg_pass2: "Confirmer le mot de passe",
    cfg_min: "8 caractères minimum.",
    cfg_mismatch: "Les deux mots de passe ne correspondent pas.",
    strength0: "trop court", strength1: "faible", strength2: "moyen", strength3: "bon", strength4: "excellent",
    btn_create: "Créer le compte et terminer",
    btn_finish: "Préparer et terminer",
    done_title: "Installation terminée",
    done_sub: "Lumen3D {v} est installé. Ouvrez le panneau d'administration pour créer votre compte et personnaliser la plateforme (assistant guidé).",
    link_home: "Ouvrir la plateforme", link_home_d: "index.html",
    link_admin: "Configurer la plateforme", link_admin_d: "Créez votre compte + personnalisez (assistant)",
    done_delete: "Recommandation : supprimez install.php maintenant. Il refuse désormais de se réexécuter, mais un fichier d'installation n'a plus sa place sur un serveur en production.",
    done_updates: "Les mises à jour futures se font depuis le panneau d'administration (onglet Mises à jour).",
    done_redirect: "Redirection automatique vers la configuration (compte + identité + plugins)…",
    btn_gosetup: "Aller à la configuration",
    btn_selfdelete: "Supprimer install.php",
    deleted_title: "install.php supprimé",
    deleted_text: "L'installateur s'est supprimé du serveur. Bonne exploration !",
    locked_title: "Plateforme déjà installée",
    locked_text_credential: "Un compte administrateur existe déjà (api/admin_credential.json). Par sécurité, cet installateur refuse de s'exécuter sur une plateforme configurée.",
    locked_text_lock: "Un verrou d'installation (.install-lock) est présent : l'installation a déjà été menée à terme.",
    locked_hint: "Supprimez install.php de ce serveur — via le bouton ci-dessous ou par FTP.",
    err_title: "Une erreur est survenue",
    btn_retry: "Réessayer", btn_reload: "Recharger la page",
    err_rate_limited: "Limite d'API GitHub atteinte. Réessayez dans {m} minute(s).",
    err_rate_limited_nom: "Limite d'API GitHub atteinte. Réessayez dans quelques minutes.",
    err_no_release: "Aucune release publiée sur le dépôt GitHub {repo}.",
    err_no_release_zip: "La release ne contient aucune archive zip exploitable.",
    err_signature_missing: "Cette release n'est pas signée alors qu'une clé de signature est épinglée : authenticité impossible à prouver. Installation refusée.",
    err_signature_invalid: "La signature de la release est invalide (clé épinglée). L'archive n'a pas été produite par la clé de signature du projet. Installation refusée.",
    err_signature_unsupported: "Une clé de signature est épinglée mais l'extension PHP « sodium » est absente : impossible de vérifier l'authenticité. Activez ext-sodium (incluse dans PHP ≥ 7.2).",
    err_github_unreachable: "Impossible de joindre l'API GitHub. Vérifiez la connectivité sortante du serveur.",
    err_tls_ca_broken: "Le magasin de certificats de PHP est mal configuré sur cet hébergement (php.ini désigne un fichier CA absent) et l'installateur n'a pas pu écrire son trousseau intégré à la place. Vérifiez que le dossier est inscriptible, ou téléversez cacert.pem (https://curl.se/ca/cacert.pem) à côté de install.php, puis réessayez.",
    err_github_bad_response: "Réponse inattendue de l'API GitHub.",
    err_no_http_capability: "Ni curl ni allow_url_fopen ne sont disponibles : le serveur ne peut rien télécharger.",
    err_network: "Erreur réseau pendant le téléchargement. La reprise continuera où elle s'est arrêtée.",
    err_disk_write: "Écriture disque impossible (disque plein ou permissions). Libérez de l'espace puis réessayez : l'installation reprendra.",
    err_too_large: "L'archive dépasse la taille maximale autorisée (512 Mo).",
    err_too_large_uncompressed: "Le contenu décompressé dépasse 500 Mo — archive rejetée (protection zip-bomb).",
    err_too_many_entries: "L'archive contient plus de 20 000 fichiers — rejetée (protection zip-bomb).",
    err_size_mismatch: "La taille de l'archive ne correspond pas à la release : le téléchargement va reprendre de zéro.",
    err_sha256_mismatch: "L'empreinte SHA-256 ne correspond pas : archive supprimée, rien n'a été extrait. Le téléchargement va reprendre.",
    err_zip_open_failed: "Impossible d'ouvrir l'archive zip (fichier corrompu ?).",
    err_zip_empty: "L'archive est vide.",
    err_zip_bad_entry: "Entrée dangereuse détectée dans l'archive — extraction refusée.",
    err_zip_missing: "L'archive a disparu du disque : le téléchargement va reprendre.",
    err_zip_changed: "L'archive a changé depuis sa vérification — réinitialisation nécessaire.",
    err_zip_entry_read: "Lecture d'une entrée du zip impossible.",
    err_zip_entry_overflow: "Une entrée du zip dépasse sa taille déclarée — archive rejetée.",
    err_zip_stat_failed: "Lecture des métadonnées du zip impossible.",
    err_mkdir_failed: "Création d'un dossier impossible (permissions ?).",
    err_file_write_open: "Ouverture d'un fichier en écriture impossible (permissions ?).",
    err_weak_password: "Mot de passe trop court (8 caractères minimum).",
    err_invalid_username: "Nom d'utilisateur invalide.",
    err_already_configured: "Un compte administrateur existe déjà — rechargez la page.",
    err_credential_write_failed: "Écriture du fichier d'identifiants impossible.",
    err_state_write_failed: "Écriture du fichier d'état impossible (permissions du dossier ?).",
    err_no_state: "État d'installation introuvable — repartez de la vérification des prérequis.",
    err_wrong_phase: "L'installation n'est pas dans la phase attendue — resynchronisation…",
    err_csrf: "Session expirée. Rechargez la page pour continuer (la progression est conservée).",
    err_locked: "La plateforme est déjà configurée : installateur verrouillé.",
    err_install_incomplete: "Installation incomplète : {d}",
    err_selfdelete_failed: "Suppression automatique impossible : supprimez install.php manuellement (FTP / gestionnaire de fichiers).",
    err_unknown: "Erreur inattendue ({c}).",
    foot: "Installateur Lumen3D — aucun cookie tiers, aucune requête externe hors GitHub."
  },
  en: {
    title_suffix: "— Setup",
    noscript: "JavaScript is required to run the installer.",
    step1: "Requirements", step2: "Download", step3: "Install", step4: "Admin account", step5: "Done",
    welcome_title: "Welcome",
    welcome_sub: "This wizard downloads the latest Lumen3D release from GitHub, installs it into this directory and configures the admin account. Nothing is written before the archive is fully verified.",
    btn_start: "Start installation",
    resume_title: "Installation in progress detected",
    resume_text: "An installation of version {v} was interrupted. You can resume it where it left off.",
    btn_resume: "Resume installation", btn_restart: "Restart from zero",
    req_title: "Environment check",
    req_sub: "The installer verifies that this host can run Lumen3D.",
    req_checking: "Checking…",
    req_php: "PHP ≥ 7.4", req_zip: "Zip extension (ZipArchive)", req_http: "Outbound HTTPS (curl or allow_url_fopen)",
    req_crypto: "Crypto functions (PBKDF2)", req_writable: "Directory writable", req_disk: "Free disk space",
    req_ca: "CA certificates (HTTPS verification)",
    hint_ca: "No usable store and the built-in bundle could not be written (read-only directory?). Make the directory writable, or upload cacert.pem (https://curl.se/ca/cacert.pem) next to install.php.",
    req_perms: "Permissions of created files (dirs / files)",
    hint_perms: "PHP runs as a different user than the site owner: created files are made writable so they stay editable over FTP/SFTP.",
    hint_php: "Update PHP from your hosting control panel.",
    hint_zip: "Enable the \"zip\" extension in the PHP configuration.",
    hint_http: "Enable the curl extension or allow_url_fopen in php.ini.",
    hint_crypto: "The standard hash / openssl extensions are required.",
    hint_writable: "Grant write permissions on this directory (chmod 755 / correct owner).",
    hint_disk: "Free some space: about 2× the archive size is needed.",
    disk_unknown: "could not be measured",
    dir_not_empty: "This directory is not empty. Existing files are never deleted — only files from the verified release will be written (may overwrite).",
    release_label: "Latest release",
    release_asset: "release archive", release_zipball: "repository archive (zipball)",
    release_no_sha: "No SHA256SUMS file in this release: integrity cannot be checksum-verified.",
    release_sig_ok: "Authenticity signature verified (Ed25519): this archive genuinely comes from the project signing key.",
    btn_install: "Install version {v}", btn_recheck: "Retry",
    dl_title: "Download", dl_sub: "The archive is downloaded in slices and resumes after an interruption.",
    dl_progress: "Downloading {got} / {total} MB", dl_progress_nototal: "Downloading {got} MB",
    dl_norange: "This host does not support byte-range resume: downloading in a single pass.",
    vf_title: "Verifying the archive", vf_text: "Checking size, SHA-256 checksum and zip structure…",
    vf_sha_ok: "SHA-256 checksum verified.",
    warn_no_checksum: "No SHA-256 checksum available for this release — the archive could not be checksum-verified (warning; installation continues).",
    warn_symlinks: "Symbolic links found in the archive were skipped for safety.",
    ex_title: "Installing files", ex_sub: "Every zip entry is validated individually before being written.",
    ex_progress: "Extracting {i} / {n} files",
    vi_text: "Verifying the installation…",
    warn_no_version_json: "version.json missing from the release (auto-updates may not detect it).",
    cfg_title: "Prepare the install",
    cfg_sub: "This step prepares the data folders and the api/ protection. The admin account, identity (name, logo, texts), theme and plugins are created on the platform's first launch, via the guided setup wizard.",
    cfg_account_note: "No account is created now. The first time you open the admin panel, a wizard will guide you through creating your account and customizing the platform.",
    cfg_user: "Username", cfg_user_ph: "admin",
    cfg_pass: "Password", cfg_pass2: "Confirm password",
    cfg_min: "Minimum 8 characters.",
    cfg_mismatch: "The two passwords do not match.",
    strength0: "too short", strength1: "weak", strength2: "fair", strength3: "good", strength4: "excellent",
    btn_create: "Create account and finish",
    btn_finish: "Prepare and finish",
    done_title: "Installation complete",
    done_sub: "Lumen3D {v} is installed. Open the admin panel to create your account and customize the platform (guided wizard).",
    link_home: "Open the platform", link_home_d: "index.html",
    link_admin: "Set up the platform", link_admin_d: "Create your account + customize (wizard)",
    done_delete: "Recommendation: delete install.php now. It refuses to run again, but an installer file has no place on a production server.",
    done_updates: "Future updates are handled from the admin panel (Updates tab).",
    done_redirect: "Redirecting to setup (account + identity + plugins)…",
    btn_gosetup: "Go to setup",
    btn_selfdelete: "Delete install.php",
    deleted_title: "install.php deleted",
    deleted_text: "The installer removed itself from the server. Happy exploring!",
    locked_title: "Platform already installed",
    locked_text_credential: "An admin account already exists (api/admin_credential.json). For safety, this installer refuses to run on a configured platform.",
    locked_text_lock: "An install lock (.install-lock) is present: the installation already completed.",
    locked_hint: "Remove install.php from this server — with the button below or via FTP.",
    err_title: "Something went wrong",
    btn_retry: "Retry", btn_reload: "Reload the page",
    err_rate_limited: "GitHub API rate limit reached. Retry in {m} minute(s).",
    err_rate_limited_nom: "GitHub API rate limit reached. Retry in a few minutes.",
    err_no_release: "No release published on the GitHub repository {repo}.",
    err_no_release_zip: "The release contains no usable zip archive.",
    err_signature_missing: "This release is unsigned but a signing key is pinned: authenticity cannot be proven. Installation refused.",
    err_signature_invalid: "The release signature is invalid (pinned key). The archive was not produced by the project signing key. Installation refused.",
    err_signature_unsupported: "A signing key is pinned but the PHP \"sodium\" extension is missing: authenticity cannot be verified. Enable ext-sodium (bundled with PHP ≥ 7.2).",
    err_github_unreachable: "Cannot reach the GitHub API. Check the server's outbound connectivity.",
    err_tls_ca_broken: "This host's PHP certificate store is misconfigured (php.ini names a CA file that does not exist) and the installer could not write its built-in bundle instead. Check that the directory is writable, or upload cacert.pem (https://curl.se/ca/cacert.pem) next to install.php, then retry.",
    err_github_bad_response: "Unexpected response from the GitHub API.",
    err_no_http_capability: "Neither curl nor allow_url_fopen is available: the server cannot download anything.",
    err_network: "Network error during download. Resume will continue where it stopped.",
    err_disk_write: "Disk write failed (disk full or permissions). Free some space and retry: the install will resume.",
    err_too_large: "The archive exceeds the maximum allowed size (512 MB).",
    err_too_large_uncompressed: "Uncompressed content exceeds 500 MB — archive rejected (zip-bomb protection).",
    err_too_many_entries: "The archive contains more than 20,000 files — rejected (zip-bomb protection).",
    err_size_mismatch: "Archive size does not match the release: the download will restart.",
    err_sha256_mismatch: "SHA-256 checksum mismatch: archive deleted, nothing was extracted. The download will restart.",
    err_zip_open_failed: "Cannot open the zip archive (corrupted file?).",
    err_zip_empty: "The archive is empty.",
    err_zip_bad_entry: "Dangerous entry detected in the archive — extraction refused.",
    err_zip_missing: "The archive disappeared from disk: the download will restart.",
    err_zip_changed: "The archive changed since verification — a reset is required.",
    err_zip_entry_read: "Failed to read a zip entry.",
    err_zip_entry_overflow: "A zip entry exceeds its declared size — archive rejected.",
    err_zip_stat_failed: "Failed to read zip metadata.",
    err_mkdir_failed: "Failed to create a directory (permissions?).",
    err_file_write_open: "Failed to open a file for writing (permissions?).",
    err_weak_password: "Password too short (minimum 8 characters).",
    err_invalid_username: "Invalid username.",
    err_already_configured: "An admin account already exists — reload the page.",
    err_credential_write_failed: "Failed to write the credential file.",
    err_state_write_failed: "Failed to write the state file (directory permissions?).",
    err_no_state: "Install state not found — restart from the requirements check.",
    err_wrong_phase: "The installation is not in the expected phase — resyncing…",
    err_csrf: "Session expired. Reload the page to continue (progress is preserved).",
    err_locked: "The platform is already configured: installer locked.",
    err_install_incomplete: "Incomplete installation: {d}",
    err_selfdelete_failed: "Automatic deletion failed: remove install.php manually (FTP / file manager).",
    err_unknown: "Unexpected error ({c}).",
    foot: "Lumen3D installer — no third-party cookies, no external requests besides GitHub."
  }
};
let lang = 'fr';
try { const s = localStorage.getItem('lumen3d-install-lang'); if (s === 'en' || s === 'fr') lang = s; } catch (e) {}
function t(key, vars) {
  let s = (DICT[lang] && DICT[lang][key]) || DICT.fr[key] || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
  return s;
}

/* ── DOM helpers (textContent only for dynamic values — no HTML injection) ── */
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'text') n.textContent = attrs[k];
    else if (k === 'onclick') n.addEventListener('click', attrs[k]);
    else n.setAttribute(k, attrs[k]);
  }
  (children || []).forEach(c => { if (c) n.appendChild(c); });
  return n;
}
function view(...children) {
  const v = document.getElementById('view');
  v.textContent = '';
  const box = el('div', { class: 'fade-in' }, children);
  v.appendChild(box);
  return box;
}
function fmtMB(bytes) { return (bytes / 1048576).toFixed(1); }
function setStep(n) {
  document.querySelectorAll('#stepper li').forEach((li, i) => {
    li.classList.toggle('done', i + 1 < n);
    li.classList.toggle('active', i + 1 === n);
  });
}
function banner(kind, textKey, vars, bold) {
  const icons = { info: 'i', warn: '!', error: '×', ok: '✓' };
  return el('div', { class: 'banner banner-' + kind, role: kind === 'error' ? 'alert' : 'note' }, [
    el('span', { class: 'bicon', text: icons[kind] || 'i', 'aria-hidden': 'true' }),
    el('div', {}, [
      bold ? el('b', { text: t(bold) }) : null,
      el('span', { text: typeof textKey === 'string' ? t(textKey, vars) : textKey })
    ])
  ]);
}
function progressBar(id, indeterminate) {
  const bar = el('div', { class: 'progress' + (indeterminate ? ' indeterminate' : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, [el('div')]);
  const label = el('div', { class: 'progress-label' }, [el('span', { id: id + 'Text', text: '' }), el('span', { class: 'pct', id: id + 'Pct', text: '' })]);
  return { wrap: el('div', { class: 'progress-wrap' }, [label, bar]), bar };
}
function setProgress(pb, pct, text) {
  const inner = pb.bar.firstChild;
  if (pct === null || pct === undefined) {
    pb.bar.classList.add('indeterminate');
    pb.bar.removeAttribute('aria-valuenow');
    pb.wrap.querySelector('.pct').textContent = '';
  } else {
    pb.bar.classList.remove('indeterminate');
    inner.style.width = pct + '%';
    pb.bar.setAttribute('aria-valuenow', String(pct));
    pb.wrap.querySelector('.pct').textContent = pct + ' %';
  }
  pb.wrap.querySelector('.progress-label span').textContent = text;
}

/* ── API client ───────────────────────────────────────────────────────────── */
async function api(step, data) {
  let res, json;
  try {
    res = await fetch('?api=' + encodeURIComponent(step), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Install-CSRF': CSRF },
      body: JSON.stringify(data || {}),
      credentials: 'same-origin'
    });
  } catch (e) {
    throw { code: 'network', extra: {} };
  }
  try { json = await res.json(); } catch (e) { throw { code: 'http_' + res.status, extra: {} }; }
  if (json && json.ok === false) throw { code: json.error || ('http_' + res.status), extra: json };
  if (!res.ok) throw { code: 'http_' + res.status, extra: json || {} };
  return json;
}

/* ── Error rendering ──────────────────────────────────────────────────────── */
let installWarnings = [];
function errorMessage(err) {
  const c = err.code || 'unknown';
  if (c === 'rate_limited') {
    return err.extra && err.extra.retryAfterMin ? t('err_rate_limited', { m: err.extra.retryAfterMin }) : t('err_rate_limited_nom');
  }
  if (c === 'no_release') return t('err_no_release', { repo: 'nutchaxo/lumen3D' });
  if (c === 'install_incomplete') return t('err_install_incomplete', { d: (err.extra && err.extra.detail) || '?' });
  if (c.indexOf('zip_bad_entry') === 0) return t('err_zip_bad_entry');
  if (c.indexOf('network') === 0 || c.indexOf('http_5') === 0 || c === 'too_many_redirects' || c === 'redirect_not_https' || c === 'not_https') return t('err_network');
  if (c.indexOf('http_4') === 0) return t('err_network') + ' (' + c + ')';
  const key = 'err_' + c;
  if (DICT.fr[key]) return t(key);
  return t('err_unknown', { c: c });
}
function renderError(err, retryFn) {
  const c = err.code || 'unknown';
  // Recoverable-by-resync codes re-enter the pipeline directly.
  if (c === 'wrong_phase' || c === 'no_state' || c === 'size_mismatch' || c === 'sha256_mismatch' || c === 'zip_missing') {
    retryFn = runPipeline;
  }
  if (c === 'csrf') retryFn = () => location.reload();
  if (c === 'locked') { location.reload(); return; }
  const detail = err.extra && err.extra.detail ? err.extra.detail : null;
  view(
    banner('error', errorMessage(err), null, 'err_title'),
    detail ? el('p', { class: 'detail', text: detail }) : null,
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: c === 'csrf' ? t('btn_reload') : t('btn_retry'), onclick: retryFn }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: t('btn_restart'), onclick: restartFromZero })
    ])
  );
}
async function restartFromZero() {
  try { await api('reset'); } catch (e) { /* reset is best-effort */ }
  installWarnings = [];
  renderWelcome(false);
}

/* ── Views ────────────────────────────────────────────────────────────────── */
let currentRender = null;
function renderWelcome(resume) {
  currentRender = () => renderWelcome(resume);
  setStep(1);
  const v = BOOT.state && BOOT.state.release ? (BOOT.state.release.version || '?') : '?';
  view(
    resume ? banner('info', 'resume_text', { v: v }, 'resume_title') : null,
    el('h2', { text: t('welcome_title') }),
    el('p', { class: 'sub', text: t('welcome_sub') }),
    el('div', { class: 'actions' }, resume ? [
      el('button', { class: 'btn btn-primary', type: 'button', text: t('btn_resume'), onclick: runPipeline }),
      el('button', { class: 'btn btn-ghost', type: 'button', text: t('btn_restart'), onclick: restartFromZero })
    ] : [
      el('button', { class: 'btn btn-primary', type: 'button', text: t('btn_start'), onclick: runCheck })
    ])
  );
}

const REQ_META = {
  php: ['req_php', 'hint_php'], zip: ['req_zip', 'hint_zip'], http: ['req_http', 'hint_http'],
  crypto: ['req_crypto', 'hint_crypto'], writable: ['req_writable', 'hint_writable'], disk: ['req_disk', 'hint_disk'],
  ca: ['req_ca', 'hint_ca'], perms: ['req_perms', 'hint_perms']
};
function reqRow(r) {
  const [nameKey, hintKey] = REQ_META[r.id] || [r.id, null];
  const cls = r.ok === true ? 'req-ok' : (r.ok === false ? 'req-bad' : 'req-unk');
  const icon = r.ok === true ? '✓' : (r.ok === false ? '✗' : '?');
  let val = '';
  if (r.id === 'disk') {
    val = r.value === null ? t('disk_unknown') : (fmtMB(r.value) + ' ' + (lang === 'fr' ? 'Mo' : 'MB') + ' / ' + (lang === 'fr' ? 'requis ' : 'needs ') + fmtMB(r.need) + ' ' + (lang === 'fr' ? 'Mo' : 'MB'));
  } else if (r.value) val = String(r.value);
  return el('li', { class: cls }, [
    el('span', { class: 'req-ic', text: icon, 'aria-hidden': 'true' }),
    el('span', { class: 'req-name' }, [
      el('span', { text: t(nameKey) }),
      (r.ok === false || r.hintAlways) && hintKey ? el('span', { class: 'req-hint', text: t(hintKey) }) : null
    ]),
    el('span', { class: 'req-val', text: val })
  ]);
}
async function runCheck() {
  currentRender = runCheck;
  setStep(1);
  view(el('h2', { text: t('req_title') }), el('p', { class: 'sub', text: t('req_checking') }));
  let resp;
  try { resp = await api('check'); } catch (err) { renderError(err, runCheck); return; }

  const children = [
    el('h2', { text: t('req_title') }),
    el('p', { class: 'sub', text: t('req_sub') }),
    el('ul', { class: 'req-list' }, (resp.requirements || []).map(reqRow))
  ];
  if (resp.dirNotEmpty) children.push(banner('warn', 'dir_not_empty'));
  if (resp.releaseError) {
    children.push(banner('error', errorMessage({ code: resp.releaseError.code, extra: resp.releaseError })));
    if (resp.releaseError.detail) children.push(el('p', { class: 'detail', text: resp.releaseError.detail }));
    children.push(el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: t('btn_recheck'), onclick: runCheck })
    ]));
    view(...children);
    return;
  }
  const rel = resp.release;
  children.push(el('div', { class: 'release-box' }, [
    el('div', {}, [
      el('div', {}, [el('span', { text: t('release_label') + ' : ' }), el('span', { class: 'ver', text: 'v' + rel.version })]),
      el('div', { class: 'meta', text: (rel.zipball ? t('release_zipball') : (rel.assetName || t('release_asset'))) + (rel.size ? ' · ' + fmtMB(rel.size) + (lang === 'fr' ? ' Mo' : ' MB') : '') })
    ])
  ]));
  if (!rel.hasSha256) children.push(banner('warn', 'release_no_sha'));
  if (rel.sigVerified) children.push(banner('ok', 'release_sig_ok'));
  const pass = resp.requirementsPass;
  children.push(el('div', { class: 'actions' }, [
    el('button', { class: 'btn btn-primary', type: 'button', text: t('btn_install', { v: rel.version }), onclick: runPipeline, ...(pass ? {} : { disabled: 'disabled' }) }),
    el('button', { class: 'btn btn-ghost', type: 'button', text: t('btn_recheck'), onclick: runCheck })
  ]));
  view(...children);
}

/* ── Pipeline (server-phase driven; every stage idempotent) ───────────────── */
let pipelineActive = false;
async function runPipeline() {
  if (pipelineActive) return;
  pipelineActive = true;
  try {
    for (;;) {
      const st = await api('status');
      if (st.locked) { location.reload(); return; }
      const phase = st.state && st.state.phase;
      if (phase === 'ready' || phase === 'downloading') await downloadLoop(st.state);
      else if (phase === 'downloaded') await verifyArchive();
      else if (phase === 'verified' || phase === 'extracting') await extractLoop(st.state);
      else if (phase === 'extracted') await verifyInstall();
      else if (phase === 'installed') { renderConfigure(); return; }
      else if (phase === 'configured') { await finalize(st.state); return; }
      else { renderWelcome(false); return; }
    }
  } catch (err) {
    renderError(err, runPipeline);
  } finally {
    pipelineActive = false;
  }
}
async function downloadLoop(state) {
  currentRender = runPipeline;
  setStep(2);
  const pb = progressBar('dl');
  const note = el('p', { class: 'sub', id: 'dlNote', text: '' });
  view(el('h2', { text: t('dl_title') }), el('p', { class: 'sub', text: t('dl_sub') }), pb.wrap, note);
  const size = state.release && state.release.size;
  setProgress(pb, size ? Math.floor((state.received || 0) * 100 / size) : null,
    size ? t('dl_progress', { got: fmtMB(state.received || 0), total: fmtMB(size) }) : t('dl_progress_nototal', { got: fmtMB(state.received || 0) }));
  for (;;) {
    const r = await api('download');
    const text = r.total ? t('dl_progress', { got: fmtMB(r.received), total: fmtMB(r.total) }) : t('dl_progress_nototal', { got: fmtMB(r.received) });
    setProgress(pb, r.pct, text);
    if (r.noRange) note.textContent = t('dl_norange');
    if (r.done) return;
  }
}
async function verifyArchive() {
  currentRender = runPipeline;
  setStep(3);
  const pb = progressBar('vf', true);
  view(el('h2', { text: t('vf_title') }), el('p', { class: 'sub', text: t('vf_text') }), pb.wrap);
  setProgress(pb, null, t('vf_text'));
  const r = await api('verify');
  (r.warnings || []).forEach(w => { if (installWarnings.indexOf(w) < 0) installWarnings.push(w); });
}
async function extractLoop(state) {
  currentRender = runPipeline;
  setStep(3);
  const pb = progressBar('ex');
  const warnBox = el('div');
  installWarnings.forEach(w => {
    if (w === 'no_checksum') warnBox.appendChild(banner('warn', 'warn_no_checksum'));
    if (w === 'symlinks_skipped') warnBox.appendChild(banner('warn', 'warn_symlinks'));
  });
  view(el('h2', { text: t('ex_title') }), el('p', { class: 'sub', text: t('ex_sub') }), warnBox, pb.wrap);
  const total0 = state.entriesTotal || 0;
  setProgress(pb, total0 ? Math.floor((state.extractedIndex || 0) * 100 / total0) : 0,
    t('ex_progress', { i: state.extractedIndex || 0, n: total0 }));
  for (;;) {
    const r = await api('extract');
    setProgress(pb, r.pct, t('ex_progress', { i: r.index, n: r.total }));
    if (r.done) return;
  }
}
async function verifyInstall() {
  currentRender = runPipeline;
  setStep(3);
  const pb = progressBar('vi', true);
  view(el('h2', { text: t('vf_title') }), el('p', { class: 'sub', text: t('vi_text') }), pb.wrap);
  setProgress(pb, null, t('vi_text'));
  const r = await api('verify');
  (r.warnings || []).forEach(w => { if (installWarnings.indexOf(w) < 0) installWarnings.push(w); });
}
function pwScore(pw) {
  if (pw.length < 8) return 0;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  let s = 1;
  if (pw.length >= 12) s++;
  if (classes >= 3) s++;
  if (classes === 4 && pw.length >= 14) s++;
  return s;
}
function renderConfigure() {
  currentRender = renderConfigure;
  setStep(4);
  // White-label: the installer no longer creates the admin account here. It only
  // prepares the data folders + api/.htaccess; the guided setup wizard (admin panel,
  // first visit) creates the account + identity + theme + plugins. This step is a
  // single confirmation button.
  const errBox = el('div');
  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit', text: t('btn_finish') });
  const form = el('form', {}, [
    banner('info', 'cfg_account_note'),
    errBox,
    el('div', { class: 'actions' }, [submitBtn])
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.textContent = '';
    submitBtn.disabled = true;
    try {
      await api('configure', {});                  // prepare infra (no account here)
      await runPipeline();                         // → configured → finalize → done
    } catch (err) {
      submitBtn.disabled = false;
      renderError(err, renderConfigure);
    }
  });
  view(el('h2', { text: t('cfg_title') }), el('p', { class: 'sub', text: t('cfg_sub') }), form);
}
async function finalize(state) {
  const version = (state && state.release && state.release.version) || '';
  await api('finalize');
  renderDone(version);
}
function renderDone(version) {
  currentRender = () => renderDone(version);
  setStep(5);
  document.querySelectorAll('#stepper li').forEach(li => { li.classList.add('done'); li.classList.remove('active'); });
  const warnBox = el('div');
  installWarnings.forEach(w => {
    if (w === 'no_checksum') warnBox.appendChild(banner('warn', 'warn_no_checksum'));
    if (w === 'no_version_json') warnBox.appendChild(banner('warn', 'warn_no_version_json'));
  });
  view(
    el('div', { class: 'checkmark', 'aria-hidden': 'true', text: '✓' }),
    el('h2', { class: 'center', text: t('done_title') }),
    el('p', { class: 'sub center', text: t('done_sub', { v: version ? 'v' + version : '' }) }),
    warnBox,
    el('p', { class: 'sub center', text: t('done_redirect') }),
    el('div', { class: 'actions' }, [
      el('a', { class: 'btn btn-primary', href: 'admpan.html', text: t('btn_gosetup') })
    ]),
    banner('info', 'done_delete'),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: t('btn_selfdelete'), onclick: selfDelete })
    ])
  );
  // The home page is blank until the operator completes the admin setup wizard, so
  // send them straight there. (A manual button is shown too, in case JS nav is blocked.)
  try { setTimeout(function () { location.href = 'admpan.html'; }, 3000); } catch (e) {}
}
function renderLocked() {
  currentRender = renderLocked;
  document.getElementById('stepper').style.display = 'none';
  view(
    el('h2', { text: t('locked_title') }),
    el('p', { class: 'sub', text: t(BOOT.lockedReason === 'lock' ? 'locked_text_lock' : 'locked_text_credential') }),
    banner('info', 'locked_hint'),
    BOOT.hasIndex ? el('div', { class: 'final-links' }, [
      el('a', { href: 'admpan.html' }, [el('span', { text: t('link_admin'), style: 'display:block' }), el('span', { text: t('link_admin_d') })])
    ]) : null,
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn btn-danger', type: 'button', text: t('btn_selfdelete'), onclick: selfDelete })
    ])
  );
}
async function selfDelete() {
  try {
    await api('selfdelete');
    document.getElementById('stepper').style.display = 'none';
    view(
      el('div', { class: 'checkmark', 'aria-hidden': 'true', text: '✓' }),
      el('h2', { class: 'center', text: t('deleted_title') }),
      el('p', { class: 'sub center', text: t('deleted_text') }),
      el('div', { class: 'final-links' }, [
        el('a', { href: 'admpan.html' }, [el('span', { text: t('link_admin'), style: 'display:block' }), el('span', { text: t('link_admin_d') })])
      ])
    );
  } catch (err) {
    view(
      banner('error', 'err_selfdelete_failed'),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', text: t('btn_retry'), onclick: selfDelete })
      ])
    );
  }
}

/* ── Language toggle + boot ───────────────────────────────────────────────── */
function applyLang() {
  document.documentElement.lang = lang;
  document.getElementById('langBtn').textContent = lang === 'fr' ? 'EN' : 'FR';
  document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.getAttribute('data-i18n')); });
  document.getElementById('footNote').textContent = t('foot');
  if (currentRender) currentRender();
}
document.getElementById('langBtn').addEventListener('click', () => {
  lang = lang === 'fr' ? 'en' : 'fr';
  try { localStorage.setItem('lumen3d-install-lang', lang); } catch (e) {}
  applyLang();
});

(function boot() {
  if (BOOT.locked) { currentRender = renderLocked; }
  else {
    const phase = BOOT.state && BOOT.state.phase;
    currentRender = phase ? () => renderWelcome(true) : () => renderWelcome(false);
  }
  applyLang();
})();
</script>
</body>
</html>
HTML;
}

/**
 * Mozilla's CA root bundle, embedded so the installer can bootstrap TLS by itself on
 * a host whose php.ini names a CA file that does not exist AND whose system store is
 * unreadable (open_basedir). Materialized to CA_SEED_FILE only when nothing else is
 * usable — see ca_probe(). The platform then carries its own copy at api/ca-bundle.pem,
 * refreshed by every update, so the trust store cannot rot or be deleted by accident.
 * Source: https://curl.se/ca/cacert.pem (Mozilla export; its date is in the header below).
 */
function embedded_ca_bundle(): string {
    return <<<'LUMEN_CA_BUNDLE'
##
## Bundle of CA Root Certificates
##
## Certificate data from Mozilla as of: Thu Jul 16 03:12:01 2026 GMT
##
## Find updated versions here: https://curl.se/docs/caextract.html
##
## This is a bundle of X.509 certificates of public Certificate Authorities
## (CA). These were automatically extracted from Mozilla's root certificates
## file (certdata.txt).  This file can be found in the mozilla source tree:
## https://raw.githubusercontent.com/mozilla-firefox/firefox/refs/heads/release/security/nss/lib/ckfw/builtins/certdata.txt
##
## It contains the certificates in PEM format and therefore
## can be directly used with curl / libcurl / php_curl, or with
## an Apache+mod_ssl webserver for SSL client authentication.
## Configure this file as the SSLCACertificateFile.
##
## Conversion done with mk-ca-bundle.pl version 1.33.
## SHA256: e57912808daef7b2b0fa4df2ccf17e47aeaf26c839a38f85c76003ebafd866bd
##


COMODO ECC Certification Authority
==================================
-----BEGIN CERTIFICATE-----
MIICiTCCAg+gAwIBAgIQH0evqmIAcFBUTAGem2OZKjAKBggqhkjOPQQDAzCBhTELMAkGA1UEBhMC
R0IxGzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEaMBgGA1UE
ChMRQ09NT0RPIENBIExpbWl0ZWQxKzApBgNVBAMTIkNPTU9ETyBFQ0MgQ2VydGlmaWNhdGlvbiBB
dXRob3JpdHkwHhcNMDgwMzA2MDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBhTELMAkGA1UEBhMCR0Ix
GzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEaMBgGA1UEChMR
Q09NT0RPIENBIExpbWl0ZWQxKzApBgNVBAMTIkNPTU9ETyBFQ0MgQ2VydGlmaWNhdGlvbiBBdXRo
b3JpdHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQDR3svdcmCFYX7deSRFtSrYpn1PlILBs5BAH+X
4QokPB0BBO490o0JlwzgdeT6+3eKKvUDYEs2ixYjFq0JcfRK9ChQtP6IHG4/bC8vCVlbpVsLM5ni
wz2J+Wos77LTBumjQjBAMB0GA1UdDgQWBBR1cacZSBm8nZ3qQUfflMRId5nTeTAOBgNVHQ8BAf8E
BAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNoADBlAjEA7wNbeqy3eApyt4jf/7VG
FAkK+qDmfQjGGoe9GKhzvSbKYAydzpmfz1wPMOG+FDHqAjAU9JM8SaczepBGR7NjfRObTrdvGDeA
U/7dIOA1mjbRxwG55tzd8/8dLDoWV9mSOdY=
-----END CERTIFICATE-----

ePKI Root Certification Authority
=================================
-----BEGIN CERTIFICATE-----
MIIFsDCCA5igAwIBAgIQFci9ZUdcr7iXAF7kBtK8nTANBgkqhkiG9w0BAQUFADBeMQswCQYDVQQG
EwJUVzEjMCEGA1UECgwaQ2h1bmdod2EgVGVsZWNvbSBDby4sIEx0ZC4xKjAoBgNVBAsMIWVQS0kg
Um9vdCBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTAeFw0wNDEyMjAwMjMxMjdaFw0zNDEyMjAwMjMx
MjdaMF4xCzAJBgNVBAYTAlRXMSMwIQYDVQQKDBpDaHVuZ2h3YSBUZWxlY29tIENvLiwgTHRkLjEq
MCgGA1UECwwhZVBLSSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEA4SUP7o3biDN1Z82tH306Tm2d0y8U82N0ywEhajfqhFAHSyZbCUNs
IZ5qyNUD9WBpj8zwIuQf5/dqIjG3LBXy4P4AakP/h2XGtRrBp0xtInAhijHyl3SJCRImHJ7K2RKi
lTza6We/CKBk49ZCt0Xvl/T29de1ShUCWH2YWEtgvM3XDZoTM1PRYfl61dd4s5oz9wCGzh1NlDiv
qOx4UXCKXBCDUSH3ET00hl7lSM2XgYI1TBnsZfZrxQWh7kcT1rMhJ5QQCtkkO7q+RBNGMD+XPNjX
12ruOzjjK9SXDrkb5wdJfzcq+Xd4z1TtW0ado4AOkUPB1ltfFLqfpo0kR0BZv3I4sjZsN/+Z0V0O
WQqraffAsgRFelQArr5T9rXn4fg8ozHSqf4hUmTFpmfwdQcGlBSBVcYn5AGPF8Fqcde+S/uUWH1+
ETOxQvdibBjWzwloPn9s9h6PYq2lY9sJpx8iQkEeb5mKPtf5P0B6ebClAZLSnT0IFaUQAS2zMnao
lQ2zepr7BxB4EW/hj8e6DyUadCrlHJhBmd8hh+iVBmoKs2pHdmX2Os+PYhcZewoozRrSgx4hxyy/
vv9haLdnG7t4TY3OZ+XkwY63I2binZB1NJipNiuKmpS5nezMirH4JYlcWrYvjB9teSSnUmjDhDXi
Zo1jDiVN1Rmy5nk3pyKdVDECAwEAAaNqMGgwHQYDVR0OBBYEFB4M97Zn8uGSJglFwFU5Lnc/Qkqi
MAwGA1UdEwQFMAMBAf8wOQYEZyoHAAQxMC8wLQIBADAJBgUrDgMCGgUAMAcGBWcqAwAABBRFsMLH
ClZ87lt4DJX5GFPBphzYEDANBgkqhkiG9w0BAQUFAAOCAgEACbODU1kBPpVJufGBuvl2ICO1J2B0
1GqZNF5sAFPZn/KmsSQHRGoqxqWOeBLoR9lYGxMqXnmbnwoqZ6YlPwZpVnPDimZI+ymBV3QGypzq
KOg4ZyYr8dW1P2WT+DZdjo2NQCCHGervJ8A9tDkPJXtoUHRVnAxZfVo9QZQlUgjgRywVMRnVvwdV
xrsStZf0X4OFunHB2WyBEXYKCrC/gpf36j36+uwtqSiUO1bd0lEursC9CBWMd1I0ltabrNMdjmEP
NXubrjlpC2JgQCA2j6/7Nu4tCEoduL+bXPjqpRugc6bY+G7gMwRfaKonh+3ZwZCc7b3jajWvY9+r
GNm65ulK6lCKD2GTHuItGeIwlDWSXQ62B68ZgI9HkFFLLk3dheLSClIKF5r8GrBQAuUBo2M3IUxE
xJtRmREOc5wGj1QupyheRDmHVi03vYVElOEMSyycw5KFNGHLD7ibSkNS/jQ6fbjpKdx2qcgw+BRx
gMYeNkh0IkFch4LoGHGLQYlE535YW6i4jRPpp2zDR+2zGp1iro2C6pSe3VkQw63d4k3jMdXH7Ojy
sP6SHhYKGvzZ8/gntsm+HbRsZJB/9OTEW9c3rkIO3aQab3yIVMUWbuF6aC74Or8NpDyJO3inTmOD
BCEIZ43ygknQW/2xzQ+DhNQ+IIX3Sj0rnP0qCglN6oH4EZw=
-----END CERTIFICATE-----

NetLock Arany (Class Gold) Főtanúsítvány
========================================
-----BEGIN CERTIFICATE-----
MIIEFTCCAv2gAwIBAgIGSUEs5AAQMA0GCSqGSIb3DQEBCwUAMIGnMQswCQYDVQQGEwJIVTERMA8G
A1UEBwwIQnVkYXBlc3QxFTATBgNVBAoMDE5ldExvY2sgS2Z0LjE3MDUGA1UECwwuVGFuw7pzw610
dsOhbnlraWFkw7NrIChDZXJ0aWZpY2F0aW9uIFNlcnZpY2VzKTE1MDMGA1UEAwwsTmV0TG9jayBB
cmFueSAoQ2xhc3MgR29sZCkgRsWRdGFuw7pzw610dsOhbnkwHhcNMDgxMjExMTUwODIxWhcNMjgx
MjA2MTUwODIxWjCBpzELMAkGA1UEBhMCSFUxETAPBgNVBAcMCEJ1ZGFwZXN0MRUwEwYDVQQKDAxO
ZXRMb2NrIEtmdC4xNzA1BgNVBAsMLlRhbsO6c8OtdHbDoW55a2lhZMOzayAoQ2VydGlmaWNhdGlv
biBTZXJ2aWNlcykxNTAzBgNVBAMMLE5ldExvY2sgQXJhbnkgKENsYXNzIEdvbGQpIEbFkXRhbsO6
c8OtdHbDoW55MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxCRec75LbRTDofTjl5Bu
0jBFHjzuZ9lk4BqKf8owyoPjIMHj9DrTlF8afFttvzBPhCf2nx9JvMaZCpDyD/V/Q4Q3Y1GLeqVw
/HpYzY6b7cNGbIRwXdrzAZAj/E4wqX7hJ2Pn7WQ8oLjJM2P+FpD/sLj916jAwJRDC7bVWaaeVtAk
H3B5r9s5VA1lddkVQZQBr17s9o3x/61k/iCa11zr/qYfCGSji3ZVrR47KGAuhyXoqq8fxmRGILdw
fzzeSNuWU7c5d+Qa4scWhHaXWy+7GRWF+GmF9ZmnqfI0p6m2pgP8b4Y9VHx2BJtr+UBdADTHLpl1
neWIA6pN+APSQnbAGwIDAKiLo0UwQzASBgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIB
BjAdBgNVHQ4EFgQUzPpnk/C2uNClwB7zU/2MU9+D15YwDQYJKoZIhvcNAQELBQADggEBAKt/7hwW
qZw8UQCgwBEIBaeZ5m8BiFRhbvG5GK1Krf6BQCOUL/t1fC8oS2IkgYIL9WHxHG64YTjrgfpioTta
YtOUZcTh5m2C+C8lcLIhJsFyUR+MLMOEkMNaj7rP9KdlpeuY0fsFskZ1FSNqb4VjMIDw1Z4fKRzC
bLBQWV2QWzuoDTDPv31/zvGdg73JRm4gpvlhUbohL3u+pRVjodSVh/GeufOJ8z2FuLjbvrW5Kfna
NwUASZQDhETnv0Mxz3WLJdH0pmT1kvarBes96aULNmLazAZfNou2XjG4Kvte9nHfRCaexOYNkbQu
dZWAUWpLMKawYqGT8ZvYzsRjdT9ZR7E=
-----END CERTIFICATE-----

Microsec e-Szigno Root CA 2009
==============================
-----BEGIN CERTIFICATE-----
MIIECjCCAvKgAwIBAgIJAMJ+QwRORz8ZMA0GCSqGSIb3DQEBCwUAMIGCMQswCQYDVQQGEwJIVTER
MA8GA1UEBwwIQnVkYXBlc3QxFjAUBgNVBAoMDU1pY3Jvc2VjIEx0ZC4xJzAlBgNVBAMMHk1pY3Jv
c2VjIGUtU3ppZ25vIFJvb3QgQ0EgMjAwOTEfMB0GCSqGSIb3DQEJARYQaW5mb0BlLXN6aWduby5o
dTAeFw0wOTA2MTYxMTMwMThaFw0yOTEyMzAxMTMwMThaMIGCMQswCQYDVQQGEwJIVTERMA8GA1UE
BwwIQnVkYXBlc3QxFjAUBgNVBAoMDU1pY3Jvc2VjIEx0ZC4xJzAlBgNVBAMMHk1pY3Jvc2VjIGUt
U3ppZ25vIFJvb3QgQ0EgMjAwOTEfMB0GCSqGSIb3DQEJARYQaW5mb0BlLXN6aWduby5odTCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOn4j/NjrdqG2KfgQvvPkd6mJviZpWNwrZuuyjNA
fW2WbqEORO7hE52UQlKavXWFdCyoDh2Tthi3jCyoz/tccbna7P7ofo/kLx2yqHWH2Leh5TvPmUpG
0IMZfcChEhyVbUr02MelTTMuhTlAdX4UfIASmFDHQWe4oIBhVKZsTh/gnQ4H6cm6M+f+wFUoLAKA
pxn1ntxVUwOXewdI/5n7N4okxFnMUBBjjqqpGrCEGob5X7uxUG6k0QrM1XF+H6cbfPVTbiJfyyvm
1HxdrtbCxkzlBQHZ7Vf8wSN5/PrIJIOV87VqUQHQd9bpEqH5GoP7ghu5sJf0dgYzQ0mg/wu1+rUC
AwEAAaOBgDB+MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBTLD8bf
QkPMPcu1SCOhGnqmKrs0aDAfBgNVHSMEGDAWgBTLD8bfQkPMPcu1SCOhGnqmKrs0aDAbBgNVHREE
FDASgRBpbmZvQGUtc3ppZ25vLmh1MA0GCSqGSIb3DQEBCwUAA4IBAQDJ0Q5eLtXMs3w+y/w9/w0o
lZMEyL/azXm4Q5DwpL7v8u8hmLzU1F0G9u5C7DBsoKqpyvGvivo/C3NqPuouQH4frlRheesuCDfX
I/OMn74dseGkddug4lQUsbocKaQY9hK6ohQU4zE1yED/t+AFdlfBHFny+L/k7SViXITwfn4fs775
tyERzAMBVnCnEJIeGzSBHq2cGsMEPO0CYdYeBvNfOofyK/FFh+U9rNHHV4S9a67c2Pm2G2JwCz02
yULyMtd6YebS2z3PyKnJm9zbWETXbzivf3jTo60adbocwTZ8jx5tHMN1Rq41Bab2XD0h7lbwyYIi
LXpUq3DDfSJlgnCW
-----END CERTIFICATE-----

GlobalSign Root CA - R3
=======================
-----BEGIN CERTIFICATE-----
MIIDXzCCAkegAwIBAgILBAAAAAABIVhTCKIwDQYJKoZIhvcNAQELBQAwTDEgMB4GA1UECxMXR2xv
YmFsU2lnbiBSb290IENBIC0gUjMxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkdsb2Jh
bFNpZ24wHhcNMDkwMzE4MTAwMDAwWhcNMjkwMzE4MTAwMDAwWjBMMSAwHgYDVQQLExdHbG9iYWxT
aWduIFJvb3QgQ0EgLSBSMzETMBEGA1UEChMKR2xvYmFsU2lnbjETMBEGA1UEAxMKR2xvYmFsU2ln
bjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMwldpB5BngiFvXAg7aEyiie/QV2EcWt
iHL8RgJDx7KKnQRfJMsuS+FggkbhUqsMgUdwbN1k0ev1LKMPgj0MK66X17YUhhB5uzsTgHeMCOFJ
0mpiLx9e+pZo34knlTifBtc+ycsmWQ1z3rDI6SYOgxXG71uL0gRgykmmKPZpO/bLyCiR5Z2KYVc3
rHQU3HTgOu5yLy6c+9C7v/U9AOEGM+iCK65TpjoWc4zdQQ4gOsC0p6Hpsk+QLjJg6VfLuQSSaGjl
OCZgdbKfd/+RFO+uIEn8rUAVSNECMWEZXriX7613t2Saer9fwRPvm2L7DWzgVGkWqQPabumDk3F2
xmmFghcCAwEAAaNCMEAwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYE
FI/wS3+oLkUkrk1Q+mOai97i3Ru8MA0GCSqGSIb3DQEBCwUAA4IBAQBLQNvAUKr+yAzv95ZURUm7
lgAJQayzE4aGKAczymvmdLm6AC2upArT9fHxD4q/c2dKg8dEe3jgr25sbwMpjjM5RcOO5LlXbKr8
EpbsU8Yt5CRsuZRj+9xTaGdWPoO4zzUhw8lo/s7awlOqzJCK6fBdRoyV3XpYKBovHd7NADdBj+1E
bddTKJd+82cEHhXXipa0095MJ6RMG3NzdvQXmcIfeg7jLQitChws/zyrVQ4PkX4268NXSb7hLi18
YIvDQVETI53O9zJrlAGomecsMx86OyXShkDOOyyGeMlhLxS67ttVb9+E7gUJTb0o2HLO02JQZR7r
kpeDMdmztcpHWD9f
-----END CERTIFICATE-----

Izenpe.com
==========
-----BEGIN CERTIFICATE-----
MIIF8TCCA9mgAwIBAgIQALC3WhZIX7/hy/WL1xnmfTANBgkqhkiG9w0BAQsFADA4MQswCQYDVQQG
EwJFUzEUMBIGA1UECgwLSVpFTlBFIFMuQS4xEzARBgNVBAMMCkl6ZW5wZS5jb20wHhcNMDcxMjEz
MTMwODI4WhcNMzcxMjEzMDgyNzI1WjA4MQswCQYDVQQGEwJFUzEUMBIGA1UECgwLSVpFTlBFIFMu
QS4xEzARBgNVBAMMCkl6ZW5wZS5jb20wggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDJ
03rKDx6sp4boFmVqscIbRTJxldn+EFvMr+eleQGPicPK8lVx93e+d5TzcqQsRNiekpsUOqHnJJAK
ClaOxdgmlOHZSOEtPtoKct2jmRXagaKH9HtuJneJWK3W6wyyQXpzbm3benhB6QiIEn6HLmYRY2xU
+zydcsC8Lv/Ct90NduM61/e0aL6i9eOBbsFGb12N4E3GVFWJGjMxCrFXuaOKmMPsOzTFlUFpfnXC
PCDFYbpRR6AgkJOhkEvzTnyFRVSa0QUmQbC1TR0zvsQDyCV8wXDbO/QJLVQnSKwv4cSsPsjLkkxT
OTcj7NMB+eAJRE1NZMDhDVqHIrytG6P+JrUV86f8hBnp7KGItERphIPzidF0BqnMC9bC3ieFUCbK
F7jJeodWLBoBHmy+E60QrLUk9TiRodZL2vG70t5HtfG8gfZZa88ZU+mNFctKy6lvROUbQc/hhqfK
0GqfvEyNBjNaooXlkDWgYlwWTvDjovoDGrQscbNYLN57C9saD+veIR8GdwYDsMnvmfzAuU8Lhij+
0rnq49qlw0dpEuDb8PYZi+17cNcC1u2HGCgsBCRMd+RIihrGO5rUD8r6ddIBQFqNeb+Lz0vPqhbB
leStTIo+F5HUsWLlguWABKQDfo2/2n+iD5dPDNMN+9fR5XJ+HMh3/1uaD7euBUbl8agW7EekFwID
AQABo4H2MIHzMIGwBgNVHREEgagwgaWBD2luZm9AaXplbnBlLmNvbaSBkTCBjjFHMEUGA1UECgw+
SVpFTlBFIFMuQS4gLSBDSUYgQTAxMzM3MjYwLVJNZXJjLlZpdG9yaWEtR2FzdGVpeiBUMTA1NSBG
NjIgUzgxQzBBBgNVBAkMOkF2ZGEgZGVsIE1lZGl0ZXJyYW5lbyBFdG9yYmlkZWEgMTQgLSAwMTAx
MCBWaXRvcmlhLUdhc3RlaXowDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0O
BBYEFB0cZQ6o8iV7tJHP5LGx5r1VdGwFMA0GCSqGSIb3DQEBCwUAA4ICAQB4pgwWSp9MiDrAyw6l
Fn2fuUhfGI8NYjb2zRlrrKvV9pF9rnHzP7MOeIWblaQnIUdCSnxIOvVFfLMMjlF4rJUT3sb9fbga
kEyrkgPH7UIBzg/YsfqikuFgba56awmqxinuaElnMIAkejEWOVt+8Rwu3WwJrfIxwYJOubv5vr8q
hT/AQKM6WfxZSzwoJNu0FXWuDYi6LnPAvViH5ULy617uHjAimcs30cQhbIHsvm0m5hzkQiCeR7Cs
g1lwLDXWrzY0tM07+DKo7+N4ifuNRSzanLh+QBxh5z6ikixL8s36mLYp//Pye6kfLqCTVyvehQP5
aTfLnnhqBbTFMXiJ7HqnheG5ezzevh55hM6fcA5ZwjUukCox2eRFekGkLhObNA5me0mrZJfQRsN5
nXJQY6aYWwa9SG3YOYNw6DXwBdGqvOPbyALqfP2C2sJbUjWumDqtujWTI6cfSN01RpiyEGjkpTHC
ClguGYEQyVB1/OpaFs4R1+7vUIgtYf8/QnMFlEPVjjxOAToZpR9GTnfQXeWBIiGH/pR9hNiTrdZo
Q0iy2+tzJOeRf1SktoA+naM8THLCV8Sg1Mw4J87VBp6iSNnpn86CcDaTmjvfliHjWbcM2pE38P1Z
WrOZyGlsQyYBNWNgVYkDOnXYukrZVP/u3oDYLdE41V4tC5h9Pmzb/CaIxw==
-----END CERTIFICATE-----

Go Daddy Root Certificate Authority - G2
========================================
-----BEGIN CERTIFICATE-----
MIIDxTCCAq2gAwIBAgIBADANBgkqhkiG9w0BAQsFADCBgzELMAkGA1UEBhMCVVMxEDAOBgNVBAgT
B0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxGjAYBgNVBAoTEUdvRGFkZHkuY29tLCBJbmMu
MTEwLwYDVQQDEyhHbyBEYWRkeSBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eSAtIEcyMB4XDTA5
MDkwMTAwMDAwMFoXDTM3MTIzMTIzNTk1OVowgYMxCzAJBgNVBAYTAlVTMRAwDgYDVQQIEwdBcml6
b25hMRMwEQYDVQQHEwpTY290dHNkYWxlMRowGAYDVQQKExFHb0RhZGR5LmNvbSwgSW5jLjExMC8G
A1UEAxMoR28gRGFkZHkgUm9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgLSBHMjCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBAL9xYgjx+lk09xvJGKP3gElY6SKDE6bFIEMBO4Tx5oVJnyfq
9oQbTqC023CYxzIBsQU+B07u9PpPL1kwIuerGVZr4oAH/PMWdYA5UXvl+TW2dE6pjYIT5LY/qQOD
+qK+ihVqf94Lw7YZFAXK6sOoBJQ7RnwyDfMAZiLIjWltNowRGLfTshxgtDj6AozO091GB94KPutd
fMh8+7ArU6SSYmlRJQVhGkSBjCypQ5Yj36w6gZoOKcUcqeldHraenjAKOc7xiID7S13MMuyFYkMl
NAJWJwGRtDtwKj9useiciAF9n9T521NtYJ2/LOdYq7hfRvzOxBsDPAnrSTFcaUaz4EcCAwEAAaNC
MEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFDqahQcQZyi27/a9
BUFuIMGU2g/eMA0GCSqGSIb3DQEBCwUAA4IBAQCZ21151fmXWWcDYfF+OwYxdS2hII5PZYe096ac
vNjpL9DbWu7PdIxztDhC2gV7+AJ1uP2lsdeu9tfeE8tTEH6KRtGX+rcuKxGrkLAngPnon1rpN5+r
5N9ss4UXnT3ZJE95kTXWXwTrgIOrmgIttRD02JDHBHNA7XIloKmf7J6raBKZV8aPEjoJpL1E/QYV
N8Gb5DKj7Tjo2GTzLH4U/ALqn83/B2gX2yKQOC16jdFU8WnjXzPKej17CuPKf1855eJ1usV2GDPO
LPAvTK33sefOT6jEm0pUBsV/fdUID+Ic/n4XuKxe9tQWskMJDE32p2u0mYRlynqI4uJEvlz36hz1
-----END CERTIFICATE-----

Starfield Root Certificate Authority - G2
=========================================
-----BEGIN CERTIFICATE-----
MIID3TCCAsWgAwIBAgIBADANBgkqhkiG9w0BAQsFADCBjzELMAkGA1UEBhMCVVMxEDAOBgNVBAgT
B0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxJTAjBgNVBAoTHFN0YXJmaWVsZCBUZWNobm9s
b2dpZXMsIEluYy4xMjAwBgNVBAMTKVN0YXJmaWVsZCBSb290IENlcnRpZmljYXRlIEF1dGhvcml0
eSAtIEcyMB4XDTA5MDkwMTAwMDAwMFoXDTM3MTIzMTIzNTk1OVowgY8xCzAJBgNVBAYTAlVTMRAw
DgYDVQQIEwdBcml6b25hMRMwEQYDVQQHEwpTY290dHNkYWxlMSUwIwYDVQQKExxTdGFyZmllbGQg
VGVjaG5vbG9naWVzLCBJbmMuMTIwMAYDVQQDEylTdGFyZmllbGQgUm9vdCBDZXJ0aWZpY2F0ZSBB
dXRob3JpdHkgLSBHMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAL3twQP89o/8ArFv
W59I2Z154qK3A2FWGMNHttfKPTUuiUP3oWmb3ooa/RMgnLRJdzIpVv257IzdIvpy3Cdhl+72WoTs
bhm5iSzchFvVdPtrX8WJpRBSiUZV9Lh1HOZ/5FSuS/hVclcCGfgXcVnrHigHdMWdSL5stPSksPNk
N3mSwOxGXn/hbVNMYq/NHwtjuzqd+/x5AJhhdM8mgkBj87JyahkNmcrUDnXMN/uLicFZ8WJ/X7Nf
ZTD4p7dNdloedl40wOiWVpmKs/B/pM293DIxfJHP4F8R+GuqSVzRmZTRouNjWwl2tVZi4Ut0HZbU
JtQIBFnQmA4O5t78w+wfkPECAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AQYwHQYDVR0OBBYEFHwMMh+n2TB/xH1oo2Kooc6rB1snMA0GCSqGSIb3DQEBCwUAA4IBAQARWfol
TwNvlJk7mh+ChTnUdgWUXuEok21iXQnCoKjUsHU48TRqneSfioYmUeYs0cYtbpUgSpIB7LiKZ3sx
4mcujJUDJi5DnUox9g61DLu34jd/IroAow57UvtruzvE03lRTs2Q9GcHGcg8RnoNAX3FWOdt5oUw
F5okxBDgBPfg8n/Uqgr/Qh037ZTlZFkSIHc40zI+OIF1lnP6aI+xy84fxez6nH7PfrHxBy22/L/K
pL/QlwVKvOoYKAKQvVR4CSFx09F9HdkWsKlhPdAKACL8x3vLCWRFCztAgfd9fDL1mMpYjn0q7pBZ
c2T5NnReJaH1ZgUufzkVqSr7UIuOhWn0
-----END CERTIFICATE-----

Starfield Services Root Certificate Authority - G2
==================================================
-----BEGIN CERTIFICATE-----
MIID7zCCAtegAwIBAgIBADANBgkqhkiG9w0BAQsFADCBmDELMAkGA1UEBhMCVVMxEDAOBgNVBAgT
B0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxJTAjBgNVBAoTHFN0YXJmaWVsZCBUZWNobm9s
b2dpZXMsIEluYy4xOzA5BgNVBAMTMlN0YXJmaWVsZCBTZXJ2aWNlcyBSb290IENlcnRpZmljYXRl
IEF1dGhvcml0eSAtIEcyMB4XDTA5MDkwMTAwMDAwMFoXDTM3MTIzMTIzNTk1OVowgZgxCzAJBgNV
BAYTAlVTMRAwDgYDVQQIEwdBcml6b25hMRMwEQYDVQQHEwpTY290dHNkYWxlMSUwIwYDVQQKExxT
dGFyZmllbGQgVGVjaG5vbG9naWVzLCBJbmMuMTswOQYDVQQDEzJTdGFyZmllbGQgU2VydmljZXMg
Um9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgLSBHMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBANUMOsQq+U7i9b4Zl1+OiFOxHz/Lz58gE20pOsgPfTz3a3Y4Y9k2YKibXlwAgLIvWX/2
h/klQ4bnaRtSmpDhcePYLQ1Ob/bISdm28xpWriu2dBTrz/sm4xq6HZYuajtYlIlHVv8loJNwU4Pa
hHQUw2eeBGg6345AWh1KTs9DkTvnVtYAcMtS7nt9rjrnvDH5RfbCYM8TWQIrgMw0R9+53pBlbQLP
LJGmpufehRhJfGZOozptqbXuNC66DQO4M99H67FrjSXZm86B0UVGMpZwh94CDklDhbZsc7tk6mFB
rMnUVN+HL8cisibMn1lUaJ/8viovxFUcdUBgF4UCVTmLfwUCAwEAAaNCMEAwDwYDVR0TAQH/BAUw
AwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFJxfAN+qAdcwKziIorhtSpzyEZGDMA0GCSqG
SIb3DQEBCwUAA4IBAQBLNqaEd2ndOxmfZyMIbw5hyf2E3F/YNoHN2BtBLZ9g3ccaaNnRbobhiCPP
E95Dz+I0swSdHynVv/heyNXBve6SbzJ08pGCL72CQnqtKrcgfU28elUSwhXqvfdqlS5sdJ/PHLTy
xQGjhdByPq1zqwubdQxtRbeOlKyWN7Wg0I8VRw7j6IPdj/3vQQF3zCepYoUz8jcI73HPdwbeyBkd
iEDPfUYd/x7H4c7/I9vG+o1VTqkC50cRRj70/b17KSa7qWFiNyi2LSr2EIZkyXCn0q23KXB56jza
YyWf/Wi3MOxw+3WKt21gZ7IeyLnp2KhvAotnDU0mV3HaIPzBSlCNsSi6
-----END CERTIFICATE-----

Certum Trusted Network CA
=========================
-----BEGIN CERTIFICATE-----
MIIDuzCCAqOgAwIBAgIDBETAMA0GCSqGSIb3DQEBBQUAMH4xCzAJBgNVBAYTAlBMMSIwIAYDVQQK
ExlVbml6ZXRvIFRlY2hub2xvZ2llcyBTLkEuMScwJQYDVQQLEx5DZXJ0dW0gQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxIjAgBgNVBAMTGUNlcnR1bSBUcnVzdGVkIE5ldHdvcmsgQ0EwHhcNMDgxMDIy
MTIwNzM3WhcNMjkxMjMxMTIwNzM3WjB+MQswCQYDVQQGEwJQTDEiMCAGA1UEChMZVW5pemV0byBU
ZWNobm9sb2dpZXMgUy5BLjEnMCUGA1UECxMeQ2VydHVtIENlcnRpZmljYXRpb24gQXV0aG9yaXR5
MSIwIAYDVQQDExlDZXJ0dW0gVHJ1c3RlZCBOZXR3b3JrIENBMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEA4/t9o3K6wvDJFIf1awFO4W5AB7ptJ11/91sts1rHUV+rpDKmYYe2bg+G0jAC
l/jXaVehGDldamR5xgFZrDwxSjh80gTSSyjoIF87B6LMTXPb865Px1bVWqeWifrzq2jUI4ZZJ88J
J7ysbnKDHDBy3+Ci6dLhdHUZvSqeexVUBBvXQzmtVSjF4hq79MDkrjhJM8x2hZ85RdKknvISjFH4
fOQtf/WsX+sWn7Et0brMkUJ3TCXJkDhv2/DM+44el1k+1WBO5gUo7Ul5E0u6SNsv+XLTOcr+H9g0
cvW0QM8xAcPs3hEtF10fuFDRXhmnad4HMyjKUJX5p1TLVIZQRan5SQIDAQABo0IwQDAPBgNVHRMB
Af8EBTADAQH/MB0GA1UdDgQWBBQIds3LB/8k9sXN7buQvOKEN0Z19zAOBgNVHQ8BAf8EBAMCAQYw
DQYJKoZIhvcNAQEFBQADggEBAKaorSLOAT2mo/9i0Eidi15ysHhE49wcrwn9I0j6vSrEuVUEtRCj
jSfeC4Jj0O7eDDd5QVsisrCaQVymcODU0HfLI9MA4GxWL+FpDQ3Zqr8hgVDZBqWo/5U30Kr+4rP1
mS1FhIrlQgnXdAIv94nYmem8J9RHjboNRhx3zxSkHLmkMcScKHQDNP8zGSal6Q10tz6XxnboJ5aj
Zt3hrvJBW8qYVoNzcOSGGtIxQbovvi0TWnZvTuhOgQ4/WwMioBK+ZlgRSssDxLQqKi2WF+A5VLxI
03YnnZotBqbJ7DnSq9ufmgsnAjUpsUCV5/nonFWIGUbWtzT1fs45mtk48VH3Tyw=
-----END CERTIFICATE-----

TWCA Root Certification Authority
=================================
-----BEGIN CERTIFICATE-----
MIIDezCCAmOgAwIBAgIBATANBgkqhkiG9w0BAQUFADBfMQswCQYDVQQGEwJUVzESMBAGA1UECgwJ
VEFJV0FOLUNBMRAwDgYDVQQLDAdSb290IENBMSowKAYDVQQDDCFUV0NBIFJvb3QgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkwHhcNMDgwODI4MDcyNDMzWhcNMzAxMjMxMTU1OTU5WjBfMQswCQYDVQQG
EwJUVzESMBAGA1UECgwJVEFJV0FOLUNBMRAwDgYDVQQLDAdSb290IENBMSowKAYDVQQDDCFUV0NB
IFJvb3QgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQCwfnK4pAOU5qfeCTiRShFAh6d8WWQUe7UREN3+v9XAu1bihSX0NXIP+FPQQeFEAcK0HMMx
QhZHhTMidrIKbw/lJVBPhYa+v5guEGcevhEFhgWQxFnQfHgQsIBct+HHK3XLfJ+utdGdIzdjp9xC
oi2SBBtQwXu4PhvJVgSLL1KbralW6cH/ralYhzC2gfeXRfwZVzsrb+RH9JlF/h3x+JejiB03HFyP
4HYlmlD4oFT/RJB2I9IyxsOrBr/8+7/zrX2SYgJbKdM1o5OaQ2RgXbL6Mv87BK9NQGr5x+PvI/1r
y+UPizgN7gr8/g+YnzAx3WxSZfmLgb4i4RxYA7qRG4kHAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIB
BjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRqOFsmjd6LWvJPelSDGRjjCDWmujANBgkqhkiG
9w0BAQUFAAOCAQEAPNV3PdrfibqHDAhUaiBQkr6wQT25JmSDCi/oQMCXKCeCMErJk/9q56YAf4lC
mtYR5VPOL8zy2gXE/uJQxDqGfczafhAJO5I1KlOy/usrBdlsXebQ79NqZp4VKIV66IIArB6nCWlW
QtNoURi+VJq/REG6Sb4gumlc7rh3zc5sH62Dlhh9DrUUOYTxKOkto557HnpyWoOzeW/vtPzQCqVY
T0bf+215WfKEIlKuD8z7fDvnaspHYcN6+NOSBB+4IIThNlQWx0DeO4pz3N/GCUzf7Nr/1FNCocny
Yh0igzyXxfkZYiesZSLX0zzG5Y6yU8xJzrww/nsOM5D77dIUkR8Hrw==
-----END CERTIFICATE-----

Security Communication RootCA2
==============================
-----BEGIN CERTIFICATE-----
MIIDdzCCAl+gAwIBAgIBADANBgkqhkiG9w0BAQsFADBdMQswCQYDVQQGEwJKUDElMCMGA1UEChMc
U0VDT00gVHJ1c3QgU3lzdGVtcyBDTy4sTFRELjEnMCUGA1UECxMeU2VjdXJpdHkgQ29tbXVuaWNh
dGlvbiBSb290Q0EyMB4XDTA5MDUyOTA1MDAzOVoXDTI5MDUyOTA1MDAzOVowXTELMAkGA1UEBhMC
SlAxJTAjBgNVBAoTHFNFQ09NIFRydXN0IFN5c3RlbXMgQ08uLExURC4xJzAlBgNVBAsTHlNlY3Vy
aXR5IENvbW11bmljYXRpb24gUm9vdENBMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ANAVOVKxUrO6xVmCxF1SrjpDZYBLx/KWvNs2l9amZIyoXvDjChz335c9S672XewhtUGrzbl+dp++
+T42NKA7wfYxEUV0kz1XgMX5iZnK5atq1LXaQZAQwdbWQonCv/Q4EpVMVAX3NuRFg3sUZdbcDE3R
3n4MqzvEFb46VqZab3ZpUql6ucjrappdUtAtCms1FgkQhNBqyjoGADdH5H5XTz+L62e4iKrFvlNV
spHEfbmwhRkGeC7bYRr6hfVKkaHnFtWOojnflLhwHyg/i/xAXmODPIMqGplrz95Zajv8bxbXH/1K
EOtOghY6rCcMU/Gt1SSwawNQwS08Ft1ENCcadfsCAwEAAaNCMEAwHQYDVR0OBBYEFAqFqXdlBZh8
QIH4D5csOPEK7DzPMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEB
CwUAA4IBAQBMOqNErLlFsceTfsgLCkLfZOoc7llsCLqJX2rKSpWeeo8HxdpFcoJxDjrSzG+ntKEj
u/Ykn8sX/oymzsLS28yN/HH8AynBbF0zX2S2ZTuJbxh2ePXcokgfGT+Ok+vx+hfuzU7jBBJV1uXk
3fs+BXziHV7Gp7yXT2g69ekuCkO2r1dcYmh8t/2jioSgrGK+KwmHNPBqAbubKVY8/gA3zyNs8U6q
tnRGEmyR7jTV7JqR50S+kDFy1UkC9gLl9B/rfNmWVan/7Ir5mUf/NVoCqgTLiluHcSmRvaS0eg29
mvVXIwAHIRc/SjnRBUkLp7Y3gaVdjKozXoEofKd9J+sAro03
-----END CERTIFICATE-----

Actalis Authentication Root CA
==============================
-----BEGIN CERTIFICATE-----
MIIFuzCCA6OgAwIBAgIIVwoRl0LE48wwDQYJKoZIhvcNAQELBQAwazELMAkGA1UEBhMCSVQxDjAM
BgNVBAcMBU1pbGFuMSMwIQYDVQQKDBpBY3RhbGlzIFMucC5BLi8wMzM1ODUyMDk2NzEnMCUGA1UE
AwweQWN0YWxpcyBBdXRoZW50aWNhdGlvbiBSb290IENBMB4XDTExMDkyMjExMjIwMloXDTMwMDky
MjExMjIwMlowazELMAkGA1UEBhMCSVQxDjAMBgNVBAcMBU1pbGFuMSMwIQYDVQQKDBpBY3RhbGlz
IFMucC5BLi8wMzM1ODUyMDk2NzEnMCUGA1UEAwweQWN0YWxpcyBBdXRoZW50aWNhdGlvbiBSb290
IENBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAp8bEpSmkLO/lGMWwUKNvUTufClrJ
wkg4CsIcoBh/kbWHuUA/3R1oHwiD1S0eiKD4j1aPbZkCkpAW1V8IbInX4ay8IMKx4INRimlNAJZa
by/ARH6jDuSRzVju3PvHHkVH3Se5CAGfpiEd9UEtL0z9KK3giq0itFZljoZUj5NDKd45RnijMCO6
zfB9E1fAXdKDa0hMxKufgFpbOr3JpyI/gCczWw63igxdBzcIy2zSekciRDXFzMwujt0q7bd9Zg1f
YVEiVRvjRuPjPdA1YprbrxTIW6HMiRvhMCb8oJsfgadHHwTrozmSBp+Z07/T6k9QnBn+locePGX2
oxgkg4YQ51Q+qDp2JE+BIcXjDwL4k5RHILv+1A7TaLndxHqEguNTVHnd25zS8gebLra8Pu2Fbe8l
EfKXGkJh90qX6IuxEAf6ZYGyojnP9zz/GPvG8VqLWeICrHuS0E4UT1lF9gxeKF+w6D9Fz8+vm2/7
hNN3WpVvrJSEnu68wEqPSpP4RCHiMUVhUE4Q2OM1fEwZtN4Fv6MGn8i1zeQf1xcGDXqVdFUNaBr8
EBtiZJ1t4JWgw5QHVw0U5r0F+7if5t+L4sbnfpb2U8WANFAoWPASUHEXMLrmeGO89LKtmyuy/uE5
jF66CyCU3nuDuP/jVo23Eek7jPKxwV2dpAtMK9myGPW1n0sCAwEAAaNjMGEwHQYDVR0OBBYEFFLY
iDrIn3hm7YnzezhwlMkCAjbQMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUUtiIOsifeGbt
ifN7OHCUyQICNtAwDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4ICAQALe3KHwGCmSUyI
WOYdiPcUZEim2FgKDk8TNd81HdTtBjHIgT5q1d07GjLukD0R0i70jsNjLiNmsGe+b7bAEzlgqqI0
JZN1Ut6nna0Oh4lScWoWPBkdg/iaKWW+9D+a2fDzWochcYBNy+A4mz+7+uAwTc+G02UQGRjRlwKx
K3JCaKygvU5a2hi/a5iB0P2avl4VSM0RFbnAKVy06Ij3Pjaut2L9HmLecHgQHEhb2rykOLpn7VU+
Xlff1ANATIGk0k9jpwlCCRT8AKnCgHNPLsBA2RF7SOp6AsDT6ygBJlh0wcBzIm2Tlf05fbsq4/aC
4yyXX04fkZT6/iyj2HYauE2yOE+b+h1IYHkm4vP9qdCa6HCPSXrW5b0KDtst842/6+OkfcvHlXHo
2qN8xcL4dJIEG4aspCJTQLas/kx2z/uUMsA1n3Y/buWQbqCmJqK4LL7RK4X9p2jIugErsWx0Hbhz
lefut8cl8ABMALJ+tguLHPPAUJ4lueAI3jZm/zel0btUZCzJJ7VLkn5l/9Mt4blOvH+kQSGQQXem
OR/qnuOf0GZvBeyqdn6/axag67XH/JJULysRJyU3eExRarDzzFhdFPFqSBX/wge2sY0PjlxQRrM9
vwGYT7JZVEc+NHt4bVaTLnPqZih4zR0Uv6CPLy64Lo7yFIrM6bV8+2ydDKXhlg==
-----END CERTIFICATE-----

Buypass Class 2 Root CA
=======================
-----BEGIN CERTIFICATE-----
MIIFWTCCA0GgAwIBAgIBAjANBgkqhkiG9w0BAQsFADBOMQswCQYDVQQGEwJOTzEdMBsGA1UECgwU
QnV5cGFzcyBBUy05ODMxNjMzMjcxIDAeBgNVBAMMF0J1eXBhc3MgQ2xhc3MgMiBSb290IENBMB4X
DTEwMTAyNjA4MzgwM1oXDTQwMTAyNjA4MzgwM1owTjELMAkGA1UEBhMCTk8xHTAbBgNVBAoMFEJ1
eXBhc3MgQVMtOTgzMTYzMzI3MSAwHgYDVQQDDBdCdXlwYXNzIENsYXNzIDIgUm9vdCBDQTCCAiIw
DQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANfHXvfBB9R3+0Mh9PT1aeTuMgHbo4Yf5FkNuud1
g1Lr6hxhFUi7HQfKjK6w3Jad6sNgkoaCKHOcVgb/S2TwDCo3SbXlzwx87vFKu3MwZfPVL4O2fuPn
9Z6rYPnT8Z2SdIrkHJasW4DptfQxh6NR/Md+oW+OU3fUl8FVM5I+GC911K2GScuVr1QGbNgGE41b
/+EmGVnAJLqBcXmQRFBoJJRfuLMR8SlBYaNByyM21cHxMlAQTn/0hpPshNOOvEu/XAFOBz3cFIqU
CqTqc/sLUegTBxj6DvEr0VQVfTzh97QZQmdiXnfgolXsttlpF9U6r0TtSsWe5HonfOV116rLJeff
awrbD02TTqigzXsu8lkBarcNuAeBfos4GzjmCleZPe4h6KP1DBbdi+w0jpwqHAAVF41og9JwnxgI
zRFo1clrUs3ERo/ctfPYV3Me6ZQ5BL/T3jjetFPsaRyifsSP5BtwrfKi+fv3FmRmaZ9JUaLiFRhn
Bkp/1Wy1TbMz4GHrXb7pmA8y1x1LPC5aAVKRCfLf6o3YBkBjqhHk/sM3nhRSP/TizPJhk9H9Z2vX
Uq6/aKtAQ6BXNVN48FP4YUIHZMbXb5tMOA1jrGKvNouicwoN9SG9dKpN6nIDSdvHXx1iY8f93ZHs
M+71bbRuMGjeyNYmsHVee7QHIJihdjK4TWxPAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wHQYD
VR0OBBYEFMmAd+BikoL1RpzzuvdMw964o605MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsF
AAOCAgEAU18h9bqwOlI5LJKwbADJ784g7wbylp7ppHR/ehb8t/W2+xUbP6umwHJdELFx7rxP462s
A20ucS6vxOOto70MEae0/0qyexAQH6dXQbLArvQsWdZHEIjzIVEpMMpghq9Gqx3tOluwlN5E40EI
osHsHdb9T7bWR9AUC8rmyrV7d35BH16Dx7aMOZawP5aBQW9gkOLo+fsicdl9sz1Gv7SEr5AcD48S
aq/v7h56rgJKihcrdv6sVIkkLE8/trKnToyokZf7KcZ7XC25y2a2t6hbElGFtQl+Ynhw/qlqYLYd
DnkM/crqJIByw5c/8nerQyIKx+u2DISCLIBrQYoIwOula9+ZEsuK1V6ADJHgJgg2SMX6OBE1/yWD
LfJ6v9r9jv6ly0UsH8SIU653DtmadsWOLB2jutXsMq7Aqqz30XpN69QH4kj3Io6wpJ9qzo6ysmD0
oyLQI+uUWnpp3Q+/QFesa1lQ2aOZ4W7+jQF5JyMV3pKdewlNWudLSDBaGOYKbeaP4NK75t98biGC
wWg5TbSYWGZizEqQXsP6JwSxeRV0mcy+rSDeJmAc61ZRpqPq5KM/p/9h3PFaTWwyI0PurKju7koS
CTxdccK+efrCh2gdC/1cacwG0Jp9VJkqyTkaGa9LKkPzY11aWOIv4x3kqdbQCtCev9eBCfHJxyYN
rJgWVqA=
-----END CERTIFICATE-----

Buypass Class 3 Root CA
=======================
-----BEGIN CERTIFICATE-----
MIIFWTCCA0GgAwIBAgIBAjANBgkqhkiG9w0BAQsFADBOMQswCQYDVQQGEwJOTzEdMBsGA1UECgwU
QnV5cGFzcyBBUy05ODMxNjMzMjcxIDAeBgNVBAMMF0J1eXBhc3MgQ2xhc3MgMyBSb290IENBMB4X
DTEwMTAyNjA4Mjg1OFoXDTQwMTAyNjA4Mjg1OFowTjELMAkGA1UEBhMCTk8xHTAbBgNVBAoMFEJ1
eXBhc3MgQVMtOTgzMTYzMzI3MSAwHgYDVQQDDBdCdXlwYXNzIENsYXNzIDMgUm9vdCBDQTCCAiIw
DQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAKXaCpUWUOOV8l6ddjEGMnqb8RB2uACatVI2zSRH
sJ8YZLya9vrVediQYkwiL944PdbgqOkcLNt4EemOaFEVcsfzM4fkoF0LXOBXByow9c3EN3coTRiR
5r/VUv1xLXA+58bEiuPwKAv0dpihi4dVsjoT/Lc+JzeOIuOoTyrvYLs9tznDDgFHmV0ST9tD+leh
7fmdvhFHJlsTmKtdFoqwNxxXnUX/iJY2v7vKB3tvh2PX0DJq1l1sDPGzbjniazEuOQAnFN44wOwZ
ZoYS6J1yFhNkUsepNxz9gjDthBgd9K5c/3ATAOux9TN6S9ZV+AWNS2mw9bMoNlwUxFFzTWsL8TQH
2xc519woe2v1n/MuwU8XKhDzzMro6/1rqy6any2CbgTUUgGTLT2G/H783+9CHaZr77kgxve9oKeV
/afmiSTYzIw0bOIjL9kSGiG5VZFvC5F5GQytQIgLcOJ60g7YaEi7ghM5EFjp2CoHxhLbWNvSO1UQ
RwUVZ2J+GGOmRj8JDlQyXr8NYnon74Do29lLBlo3WiXQCBJ31G8JUJc9yB3D34xFMFbG02SrZvPA
Xpacw8Tvw3xrizp5f7NJzz3iiZ+gMEuFuZyUJHmPfWupRWgPK9Dx2hzLabjKSWJtyNBjYt1gD1iq
j6G8BaVmos8bdrKEZLFMOVLAMLrwjEsCsLa3AgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wHQYD
VR0OBBYEFEe4zf/lb+74suwvTg75JbCOPGvDMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsF
AAOCAgEAACAjQTUEkMJAYmDv4jVM1z+s4jSQuKFvdvoWFqRINyzpkMLyPPgKn9iB5btb2iUspKdV
cSQy9sgL8rxq+JOssgfCX5/bzMiKqr5qb+FJEMwx14C7u8jYog5kV+qi9cKpMRXSIGrs/CIBKM+G
uIAeqcwRpTzyFrNHnfzSgCHEy9BHcEGhyoMZCCxt8l13nIoUE9Q2HJLw5QY33KbmkJs4j1xrG0aG
Q0JfPgEHU1RdZX33inOhmlRaHylDFCfChQ+1iHsaO5S3HWCntZznKWlXWpuTekMwGwPXYshApqr8
ZORK15FTAaggiG6cX0S5y2CBNOxv033aSF/rtJC8LakcC6wc1aJoIIAE1vyxjy+7SjENSoYc6+I2
KSb12tjE8nVhz36udmNKekBlk4f4HoCMhuWG1o8O/FMsYOgWYRqiPkN7zTlgVGr18okmAWiDSKIz
6MkEkbIRNBE+6tBDGR8Dk5AM/1E9V/RBbuHLoL7ryWPNbczk+DaqaJ3tvV2XcEQNtg413OEMXbug
UZTLfhbrES+jkkXITHHZvMmZUldGL1DPvTVp9D0VzgalLA8+9oG6lLvDu79leNKGef9JOxqDDPDe
eOzI8k1MGt6CKfjBWtrt7uYnXuhF0J0cUahoq0Tj0Itq4/g7u9xN12TyUb7mqqta6THuBrxzvxNi
Cp/HuZc=
-----END CERTIFICATE-----

T-TeleSec GlobalRoot Class 3
============================
-----BEGIN CERTIFICATE-----
MIIDwzCCAqugAwIBAgIBATANBgkqhkiG9w0BAQsFADCBgjELMAkGA1UEBhMCREUxKzApBgNVBAoM
IlQtU3lzdGVtcyBFbnRlcnByaXNlIFNlcnZpY2VzIEdtYkgxHzAdBgNVBAsMFlQtU3lzdGVtcyBU
cnVzdCBDZW50ZXIxJTAjBgNVBAMMHFQtVGVsZVNlYyBHbG9iYWxSb290IENsYXNzIDMwHhcNMDgx
MDAxMTAyOTU2WhcNMzMxMDAxMjM1OTU5WjCBgjELMAkGA1UEBhMCREUxKzApBgNVBAoMIlQtU3lz
dGVtcyBFbnRlcnByaXNlIFNlcnZpY2VzIEdtYkgxHzAdBgNVBAsMFlQtU3lzdGVtcyBUcnVzdCBD
ZW50ZXIxJTAjBgNVBAMMHFQtVGVsZVNlYyBHbG9iYWxSb290IENsYXNzIDMwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC9dZPwYiJvJK7genasfb3ZJNW4t/zN8ELg63iIVl6bmlQdTQyK
9tPPcPRStdiTBONGhnFBSivwKixVA9ZIw+A5OO3yXDw/RLyTPWGrTs0NvvAgJ1gORH8EGoel15YU
NpDQSXuhdfsaa3Ox+M6pCSzyU9XDFES4hqX2iys52qMzVNn6chr3IhUciJFrf2blw2qAsCTz34ZF
iP0Zf3WHHx+xGwpzJFu5ZeAsVMhg02YXP+HMVDNzkQI6pn97djmiH5a2OK61yJN0HZ65tOVgnS9W
0eDrXltMEnAMbEQgqxHY9Bn20pxSN+f6tsIxO0rUFJmtxxr1XV/6B7h8DR/Wgx6zAgMBAAGjQjBA
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBS1A/d2O2GCahKqGFPr
AyGUv/7OyjANBgkqhkiG9w0BAQsFAAOCAQEAVj3vlNW92nOyWL6ukK2YJ5f+AbGwUgC4TeQbIXQb
fsDuXmkqJa9c1h3a0nnJ85cp4IaH3gRZD/FZ1GSFS5mvJQQeyUapl96Cshtwn5z2r3Ex3XsFpSzT
ucpH9sry9uetuUg/vBa3wW306gmv7PO15wWeph6KU1HWk4HMdJP2udqmJQV0eVp+QD6CSyYRMG7h
P0HHRwA11fXT91Q+gT3aSWqas+8QPebrb9HIIkfLzM8BMZLZGOMivgkeGj5asuRrDFR6fUNOuIml
e9eiPZaGzPImNC1qkp2aGtAw4l1OBLBfiyB+d8E9lYLRRpo7PHi4b6HQDWSieB4pTpPDpFQUWw==
-----END CERTIFICATE-----

D-TRUST Root Class 3 CA 2 2009
==============================
-----BEGIN CERTIFICATE-----
MIIEMzCCAxugAwIBAgIDCYPzMA0GCSqGSIb3DQEBCwUAME0xCzAJBgNVBAYTAkRFMRUwEwYDVQQK
DAxELVRydXN0IEdtYkgxJzAlBgNVBAMMHkQtVFJVU1QgUm9vdCBDbGFzcyAzIENBIDIgMjAwOTAe
Fw0wOTExMDUwODM1NThaFw0yOTExMDUwODM1NThaME0xCzAJBgNVBAYTAkRFMRUwEwYDVQQKDAxE
LVRydXN0IEdtYkgxJzAlBgNVBAMMHkQtVFJVU1QgUm9vdCBDbGFzcyAzIENBIDIgMjAwOTCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANOySs96R+91myP6Oi/WUEWJNTrGa9v+2wBoqOAD
ER03UAifTUpolDWzU9GUY6cgVq/eUXjsKj3zSEhQPgrfRlWLJ23DEE0NkVJD2IfgXU42tSHKXzlA
BF9bfsyjxiupQB7ZNoTWSPOSHjRGICTBpFGOShrvUD9pXRl/RcPHAY9RySPocq60vFYJfxLLHLGv
KZAKyVXMD9O0Gu1HNVpK7ZxzBCHQqr0ME7UAyiZsxGsMlFqVlNpQmvH/pStmMaTJOKDfHR+4CS7z
p+hnUquVH+BGPtikw8paxTGA6Eian5Rp/hnd2HN8gcqW3o7tszIFZYQ05ub9VxC1X3a/L7AQDcUC
AwEAAaOCARowggEWMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFP3aFMSfMN4hvR5COfyrYyNJ
4PGEMA4GA1UdDwEB/wQEAwIBBjCB0wYDVR0fBIHLMIHIMIGAoH6gfIZ6bGRhcDovL2RpcmVjdG9y
eS5kLXRydXN0Lm5ldC9DTj1ELVRSVVNUJTIwUm9vdCUyMENsYXNzJTIwMyUyMENBJTIwMiUyMDIw
MDksTz1ELVRydXN0JTIwR21iSCxDPURFP2NlcnRpZmljYXRlcmV2b2NhdGlvbmxpc3QwQ6BBoD+G
PWh0dHA6Ly93d3cuZC10cnVzdC5uZXQvY3JsL2QtdHJ1c3Rfcm9vdF9jbGFzc18zX2NhXzJfMjAw
OS5jcmwwDQYJKoZIhvcNAQELBQADggEBAH+X2zDI36ScfSF6gHDOFBJpiBSVYEQBrLLpME+bUMJm
2H6NMLVwMeniacfzcNsgFYbQDfC+rAF1hM5+n02/t2A7nPPKHeJeaNijnZflQGDSNiH+0LS4F9p0
o3/U37CYAqxva2ssJSRyoWXuJVrl5jLn8t+rSfrzkGkj2wTZ51xY/GXUl77M/C4KzCUqNQT4YJEV
dT1B/yMfGchs64JTBKbkTCJNjYy6zltz7GRUUG3RnFX7acM2w4y8PIWmawomDeCTmGCufsYkl4ph
X5GOZpIJhzbNi5stPvZR1FDUWSi9g/LMKHtThm3YJohw1+qRzT65ysCQblrGXnRl11z+o+I=
-----END CERTIFICATE-----

D-TRUST Root Class 3 CA 2 EV 2009
=================================
-----BEGIN CERTIFICATE-----
MIIEQzCCAyugAwIBAgIDCYP0MA0GCSqGSIb3DQEBCwUAMFAxCzAJBgNVBAYTAkRFMRUwEwYDVQQK
DAxELVRydXN0IEdtYkgxKjAoBgNVBAMMIUQtVFJVU1QgUm9vdCBDbGFzcyAzIENBIDIgRVYgMjAw
OTAeFw0wOTExMDUwODUwNDZaFw0yOTExMDUwODUwNDZaMFAxCzAJBgNVBAYTAkRFMRUwEwYDVQQK
DAxELVRydXN0IEdtYkgxKjAoBgNVBAMMIUQtVFJVU1QgUm9vdCBDbGFzcyAzIENBIDIgRVYgMjAw
OTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJnxhDRwui+3MKCOvXwEz75ivJn9gpfS
egpnljgJ9hBOlSJzmY3aFS3nBfwZcyK3jpgAvDw9rKFs+9Z5JUut8Mxk2og+KbgPCdM03TP1YtHh
zRnp7hhPTFiu4h7WDFsVWtg6uMQYZB7jM7K1iXdODL/ZlGsTl28So/6ZqQTMFexgaDbtCHu39b+T
7WYxg4zGcTSHThfqr4uRjRxWQa4iN1438h3Z0S0NL2lRp75mpoo6Kr3HGrHhFPC+Oh25z1uxav60
sUYgovseO3Dvk5h9jHOW8sXvhXCtKSb8HgQ+HKDYD8tSg2J87otTlZCpV6LqYQXY+U3EJ/pure35
11H3a6UCAwEAAaOCASQwggEgMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFNOUikxiEyoZLsyv
cop9NteaHNxnMA4GA1UdDwEB/wQEAwIBBjCB3QYDVR0fBIHVMIHSMIGHoIGEoIGBhn9sZGFwOi8v
ZGlyZWN0b3J5LmQtdHJ1c3QubmV0L0NOPUQtVFJVU1QlMjBSb290JTIwQ2xhc3MlMjAzJTIwQ0El
MjAyJTIwRVYlMjAyMDA5LE89RC1UcnVzdCUyMEdtYkgsQz1ERT9jZXJ0aWZpY2F0ZXJldm9jYXRp
b25saXN0MEagRKBChkBodHRwOi8vd3d3LmQtdHJ1c3QubmV0L2NybC9kLXRydXN0X3Jvb3RfY2xh
c3NfM19jYV8yX2V2XzIwMDkuY3JsMA0GCSqGSIb3DQEBCwUAA4IBAQA07XtaPKSUiO8aEXUHL7P+
PPoeUSbrh/Yp3uDx1MYkCenBz1UbtDDZzhr+BlGmFaQt77JLvyAoJUnRpjZ3NOhk31KxEcdzes05
nsKtjHEh8lprr988TlWvsoRlFIm5d8sqMb7Po23Pb0iUMkZv53GMoKaEGTcH8gNFCSuGdXzfX2lX
ANtu2KZyIktQ1HWYVt+3GP9DQ1CuekR78HlR10M9p9OB0/DJT7naxpeG0ILD5EJt/rDiZE4OJudA
NCa1CInXCGNjOCd1HjPqbqjdn5lPdE2BiYBL3ZqXKVwvvoFBuYz/6n1gBp7N1z3TLqMVvKjmJuVv
w9y4AyHqnxbxLFS1
-----END CERTIFICATE-----

CA Disig Root R2
================
-----BEGIN CERTIFICATE-----
MIIFaTCCA1GgAwIBAgIJAJK4iNuwisFjMA0GCSqGSIb3DQEBCwUAMFIxCzAJBgNVBAYTAlNLMRMw
EQYDVQQHEwpCcmF0aXNsYXZhMRMwEQYDVQQKEwpEaXNpZyBhLnMuMRkwFwYDVQQDExBDQSBEaXNp
ZyBSb290IFIyMB4XDTEyMDcxOTA5MTUzMFoXDTQyMDcxOTA5MTUzMFowUjELMAkGA1UEBhMCU0sx
EzARBgNVBAcTCkJyYXRpc2xhdmExEzARBgNVBAoTCkRpc2lnIGEucy4xGTAXBgNVBAMTEENBIERp
c2lnIFJvb3QgUjIwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCio8QACdaFXS1tFPbC
w3OeNcJxVX6B+6tGUODBfEl45qt5WDza/3wcn9iXAng+a0EE6UG9vgMsRfYvZNSrXaNHPWSb6Wia
xswbP7q+sos0Ai6YVRn8jG+qX9pMzk0DIaPY0jSTVpbLTAwAFjxfGs3Ix2ymrdMxp7zo5eFm1tL7
A7RBZckQrg4FY8aAamkw/dLukO8NJ9+flXP04SXabBbeQTg06ov80egEFGEtQX6sx3dOy1FU+16S
GBsEWmjGycT6txOgmLcRK7fWV8x8nhfRyyX+hk4kLlYMeE2eARKmK6cBZW58Yh2EhN/qwGu1pSqV
g8NTEQxzHQuyRpDRQjrOQG6Vrf/GlK1ul4SOfW+eioANSW1z4nuSHsPzwfPrLgVv2RvPN3YEyLRa
5Beny912H9AZdugsBbPWnDTYltxhh5EF5EQIM8HauQhl1K6yNg3ruji6DOWbnuuNZt2Zz9aJQfYE
koopKW1rOhzndX0CcQ7zwOe9yxndnWCywmZgtrEE7snmhrmaZkCo5xHtgUUDi/ZnWejBBhG93c+A
Ak9lQHhcR1DIm+YfgXvkRKhbhZri3lrVx/k6RGZL5DJUfORsnLMOPReisjQS1n6yqEm70XooQL6i
Fh/f5DcfEXP7kAplQ6INfPgGAVUzfbANuPT1rqVCV3w2EYx7XsQDnYx5nQIDAQABo0IwQDAPBgNV
HRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUtZn4r7CU9eMg1gqtzk5WpC5u
Qu0wDQYJKoZIhvcNAQELBQADggIBACYGXnDnZTPIgm7ZnBc6G3pmsgH2eDtpXi/q/075KMOYKmFM
tCQSin1tERT3nLXK5ryeJ45MGcipvXrA1zYObYVybqjGom32+nNjf7xueQgcnYqfGopTpti72TVV
sRHFqQOzVju5hJMiXn7B9hJSi+osZ7z+Nkz1uM/Rs0mSO9MpDpkblvdhuDvEK7Z4bLQjb/D907Je
dR+Zlais9trhxTF7+9FGs9K8Z7RiVLoJ92Owk6Ka+elSLotgEqv89WBW7xBci8QaQtyDW2QOy7W8
1k/BfDxujRNt+3vrMNDcTa/F1balTFtxyegxvug4BkihGuLq0t4SOVga/4AOgnXmt8kHbA7v/zjx
mHHEt38OFdAlab0inSvtBfZGR6ztwPDUO+Ls7pZbkBNOHlY667DvlruWIxG68kOGdGSVyCh13x01
utI3gzhTODY7z2zp+WsO0PsE6E9312UBeIYMej4hYvF/Y3EMyZ9E26gnonW+boE+18DrG5gPcFw0
sorMwIUY6256s/daoQe/qUKS82Ail+QUoQebTnbAjn39pCXHR+3/H3OszMOl6W8KjptlwlCFtaOg
UxLMVYdh84GuEEZhvUQhuMI9dM9+JDX6HAcOmz0iyu8xL4ysEr3vQCj8KWefshNPZiTEUxnpHikV
7+ZtsH8tZ/3zbBt1RqPlShfppNcL
-----END CERTIFICATE-----

ACCVRAIZ1
=========
-----BEGIN CERTIFICATE-----
MIIH0zCCBbugAwIBAgIIXsO3pkN/pOAwDQYJKoZIhvcNAQEFBQAwQjESMBAGA1UEAwwJQUNDVlJB
SVoxMRAwDgYDVQQLDAdQS0lBQ0NWMQ0wCwYDVQQKDARBQ0NWMQswCQYDVQQGEwJFUzAeFw0xMTA1
MDUwOTM3MzdaFw0zMDEyMzEwOTM3MzdaMEIxEjAQBgNVBAMMCUFDQ1ZSQUlaMTEQMA4GA1UECwwH
UEtJQUNDVjENMAsGA1UECgwEQUNDVjELMAkGA1UEBhMCRVMwggIiMA0GCSqGSIb3DQEBAQUAA4IC
DwAwggIKAoICAQCbqau/YUqXry+XZpp0X9DZlv3P4uRm7x8fRzPCRKPfmt4ftVTdFXxpNRFvu8gM
jmoYHtiP2Ra8EEg2XPBjs5BaXCQ316PWywlxufEBcoSwfdtNgM3802/J+Nq2DoLSRYWoG2ioPej0
RGy9ocLLA76MPhMAhN9KSMDjIgro6TenGEyxCQ0jVn8ETdkXhBilyNpAlHPrzg5XPAOBOp0KoVdD
aaxXbXmQeOW1tDvYvEyNKKGno6e6Ak4l0Squ7a4DIrhrIA8wKFSVf+DuzgpmndFALW4ir50awQUZ
0m/A8p/4e7MCQvtQqR0tkw8jq8bBD5L/0KIV9VMJcRz/RROE5iZe+OCIHAr8Fraocwa48GOEAqDG
WuzndN9wrqODJerWx5eHk6fGioozl2A3ED6XPm4pFdahD9GILBKfb6qkxkLrQaLjlUPTAYVtjrs7
8yM2x/474KElB0iryYl0/wiPgL/AlmXz7uxLaL2diMMxs0Dx6M/2OLuc5NF/1OVYm3z61PMOm3WR
5LpSLhl+0fXNWhn8ugb2+1KoS5kE3fj5tItQo05iifCHJPqDQsGH+tUtKSpacXpkatcnYGMN285J
9Y0fkIkyF/hzQ7jSWpOGYdbhdQrqeWZ2iE9x6wQl1gpaepPluUsXQA+xtrn13k/c4LOsOxFwYIRK
Q26ZIMApcQrAZQIDAQABo4ICyzCCAscwfQYIKwYBBQUHAQEEcTBvMEwGCCsGAQUFBzAChkBodHRw
Oi8vd3d3LmFjY3YuZXMvZmlsZWFkbWluL0FyY2hpdm9zL2NlcnRpZmljYWRvcy9yYWl6YWNjdjEu
Y3J0MB8GCCsGAQUFBzABhhNodHRwOi8vb2NzcC5hY2N2LmVzMB0GA1UdDgQWBBTSh7Tj3zcnk1X2
VuqB5TbMjB4/vTAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFNKHtOPfNyeTVfZW6oHlNsyM
Hj+9MIIBcwYDVR0gBIIBajCCAWYwggFiBgRVHSAAMIIBWDCCASIGCCsGAQUFBwICMIIBFB6CARAA
QQB1AHQAbwByAGkAZABhAGQAIABkAGUAIABDAGUAcgB0AGkAZgBpAGMAYQBjAGkA8wBuACAAUgBh
AO0AegAgAGQAZQAgAGwAYQAgAEEAQwBDAFYAIAAoAEEAZwBlAG4AYwBpAGEAIABkAGUAIABUAGUA
YwBuAG8AbABvAGcA7QBhACAAeQAgAEMAZQByAHQAaQBmAGkAYwBhAGMAaQDzAG4AIABFAGwAZQBj
AHQAcgDzAG4AaQBjAGEALAAgAEMASQBGACAAUQA0ADYAMAAxADEANQA2AEUAKQAuACAAQwBQAFMA
IABlAG4AIABoAHQAdABwADoALwAvAHcAdwB3AC4AYQBjAGMAdgAuAGUAczAwBggrBgEFBQcCARYk
aHR0cDovL3d3dy5hY2N2LmVzL2xlZ2lzbGFjaW9uX2MuaHRtMFUGA1UdHwROMEwwSqBIoEaGRGh0
dHA6Ly93d3cuYWNjdi5lcy9maWxlYWRtaW4vQXJjaGl2b3MvY2VydGlmaWNhZG9zL3JhaXphY2N2
MV9kZXIuY3JsMA4GA1UdDwEB/wQEAwIBBjAXBgNVHREEEDAOgQxhY2N2QGFjY3YuZXMwDQYJKoZI
hvcNAQEFBQADggIBAJcxAp/n/UNnSEQU5CmH7UwoZtCPNdpNYbdKl02125DgBS4OxnnQ8pdpD70E
R9m+27Up2pvZrqmZ1dM8MJP1jaGo/AaNRPTKFpV8M9xii6g3+CfYCS0b78gUJyCpZET/LtZ1qmxN
YEAZSUNUY9rizLpm5U9EelvZaoErQNV/+QEnWCzI7UiRfD+mAM/EKXMRNt6GGT6d7hmKG9Ww7Y49
nCrADdg9ZuM8Db3VlFzi4qc1GwQA9j9ajepDvV+JHanBsMyZ4k0ACtrJJ1vnE5Bc5PUzolVt3OAJ
TS+xJlsndQAJxGJ3KQhfnlmstn6tn1QwIgPBHnFk/vk4CpYY3QIUrCPLBhwepH2NDd4nQeit2hW3
sCPdK6jT2iWH7ehVRE2I9DZ+hJp4rPcOVkkO1jMl1oRQQmwgEh0q1b688nCBpHBgvgW1m54ERL5h
I6zppSSMEYCUWqKiuUnSwdzRp+0xESyeGabu4VXhwOrPDYTkF7eifKXeVSUG7szAh1xA2syVP1Xg
Nce4hL60Xc16gwFy7ofmXx2utYXGJt/mwZrpHgJHnyqobalbz+xFd3+YJ5oyXSrjhO7FmGYvliAd
3djDJ9ew+f7Zfc3Qn48LFFhRny+Lwzgt3uiP1o2HpPVWQxaZLPSkVrQ0uGE3ycJYgBugl6H8WY3p
EfbRD0tVNEYqi4Y7
-----END CERTIFICATE-----

TWCA Global Root CA
===================
-----BEGIN CERTIFICATE-----
MIIFQTCCAymgAwIBAgICDL4wDQYJKoZIhvcNAQELBQAwUTELMAkGA1UEBhMCVFcxEjAQBgNVBAoT
CVRBSVdBTi1DQTEQMA4GA1UECxMHUm9vdCBDQTEcMBoGA1UEAxMTVFdDQSBHbG9iYWwgUm9vdCBD
QTAeFw0xMjA2MjcwNjI4MzNaFw0zMDEyMzExNTU5NTlaMFExCzAJBgNVBAYTAlRXMRIwEAYDVQQK
EwlUQUlXQU4tQ0ExEDAOBgNVBAsTB1Jvb3QgQ0ExHDAaBgNVBAMTE1RXQ0EgR2xvYmFsIFJvb3Qg
Q0EwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCwBdvI64zEbooh745NnHEKH1Jw7W2C
nJfF10xORUnLQEK1EjRsGcJ0pDFfhQKX7EMzClPSnIyOt7h52yvVavKOZsTuKwEHktSz0ALfUPZV
r2YOy+BHYC8rMjk1Ujoog/h7FsYYuGLWRyWRzvAZEk2tY/XTP3VfKfChMBwqoJimFb3u/Rk28OKR
Q4/6ytYQJ0lM793B8YVwm8rqqFpD/G2Gb3PpN0Wp8DbHzIh1HrtsBv+baz4X7GGqcXzGHaL3SekV
tTzWoWH1EfcFbx39Eb7QMAfCKbAJTibc46KokWofwpFFiFzlmLhxpRUZyXx1EcxwdE8tmx2RRP1W
KKD+u4ZqyPpcC1jcxkt2yKsi2XMPpfRaAok/T54igu6idFMqPVMnaR1sjjIsZAAmY2E2TqNGtz99
sy2sbZCilaLOz9qC5wc0GZbpuCGqKX6mOL6OKUohZnkfs8O1CWfe1tQHRvMq2uYiN2DLgbYPoA/p
yJV/v1WRBXrPPRXAb94JlAGD1zQbzECl8LibZ9WYkTunhHiVJqRaCPgrdLQABDzfuBSO6N+pjWxn
kjMdwLfS7JLIvgm/LCkFbwJrnu+8vyq8W8BQj0FwcYeyTbcEqYSjMq+u7msXi7Kx/mzhkIyIqJdI
zshNy/MGz19qCkKxHh53L46g5pIOBvwFItIm4TFRfTLcDwIDAQABoyMwITAOBgNVHQ8BAf8EBAMC
AQYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAgEAXzSBdu+WHdXltdkCY4QWwa6g
cFGn90xHNcgL1yg9iXHZqjNB6hQbbCEAwGxCGX6faVsgQt+i0trEfJdLjbDorMjupWkEmQqSpqsn
LhpNgb+E1HAerUf+/UqdM+DyucRFCCEK2mlpc3INvjT+lIutwx4116KD7+U4x6WFH6vPNOw/KP4M
8VeGTslV9xzU2KV9Bnpv1d8Q34FOIWWxtuEXeZVFBs5fzNxGiWNoRI2T9GRwoD2dKAXDOXC4Ynsg
/eTb6QihuJ49CcdP+yz4k3ZB3lLg4VfSnQO8d57+nile98FRYB/e2guyLXW3Q0iT5/Z5xoRdgFlg
lPx4mI88k1HtQJAH32RjJMtOcQWh15QaiDLxInQirqWm2BJpTGCjAu4r7NRjkgtevi92a6O2JryP
A9gK8kxkRr05YuWW6zRjESjMlfGt7+/cgFhI6Uu46mWs6fyAtbXIRfmswZ/ZuepiiI7E8UuDEq3m
i4TWnsLrgxifarsbJGAzcMzs9zLzXNl5fe+epP7JI8Mk7hWSsT2RTyaGvWZzJBPqpK5jwa19hAM8
EHiGG3njxPPyBJUgriOCxLM6AGK/5jYk4Ve6xx6QddVfP5VhK8E7zeWzaGHQRiapIVJpLesux+t3
zqY6tQMzT3bR51xUAV3LePTJDL/PEo4XLSNolOer/qmyKwbQBM0=
-----END CERTIFICATE-----

T-TeleSec GlobalRoot Class 2
============================
-----BEGIN CERTIFICATE-----
MIIDwzCCAqugAwIBAgIBATANBgkqhkiG9w0BAQsFADCBgjELMAkGA1UEBhMCREUxKzApBgNVBAoM
IlQtU3lzdGVtcyBFbnRlcnByaXNlIFNlcnZpY2VzIEdtYkgxHzAdBgNVBAsMFlQtU3lzdGVtcyBU
cnVzdCBDZW50ZXIxJTAjBgNVBAMMHFQtVGVsZVNlYyBHbG9iYWxSb290IENsYXNzIDIwHhcNMDgx
MDAxMTA0MDE0WhcNMzMxMDAxMjM1OTU5WjCBgjELMAkGA1UEBhMCREUxKzApBgNVBAoMIlQtU3lz
dGVtcyBFbnRlcnByaXNlIFNlcnZpY2VzIEdtYkgxHzAdBgNVBAsMFlQtU3lzdGVtcyBUcnVzdCBD
ZW50ZXIxJTAjBgNVBAMMHFQtVGVsZVNlYyBHbG9iYWxSb290IENsYXNzIDIwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQCqX9obX+hzkeXaXPSi5kfl82hVYAUdAqSzm1nzHoqvNK38DcLZ
SBnuaY/JIPwhqgcZ7bBcrGXHX+0CfHt8LRvWurmAwhiCFoT6ZrAIxlQjgeTNuUk/9k9uN0goOA/F
vudocP05l03Sx5iRUKrERLMjfTlH6VJi1hKTXrcxlkIF+3anHqP1wvzpesVsqXFP6st4vGCvx970
2cu+fjOlbpSD8DT6IavqjnKgP6TeMFvvhk1qlVtDRKgQFRzlAVfFmPHmBiiRqiDFt1MmUUOyCxGV
WOHAD3bZwI18gfNycJ5v/hqO2V81xrJvNHy+SE/iWjnX2J14np+GPgNeGYtEotXHAgMBAAGjQjBA
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBS/WSA2AHmgoCJrjNXy
YdK4LMuCSjANBgkqhkiG9w0BAQsFAAOCAQEAMQOiYQsfdOhyNsZt+U2e+iKo4YFWz827n+qrkRk4
r6p8FU3ztqONpfSO9kSpp+ghla0+AGIWiPACuvxhI+YzmzB6azZie60EI4RYZeLbK4rnJVM3YlNf
vNoBYimipidx5joifsFvHZVwIEoHNN/q/xWA5brXethbdXwFeilHfkCoMRN3zUA7tFFHei4R40cR
3p1m0IvVVGb6g1XqfMIpiRvpb7PO4gWEyS8+eIVibslfwXhjdFjASBgMmTnrpMwatXlajRWc2BQN
9noHV8cigwUtPJslJj0Ys6lDfMjIq2SPDqO/nBudMNva0Bkuqjzx+zOAduTNrRlPBSeOE6Fuwg==
-----END CERTIFICATE-----

Atos TrustedRoot 2011
=====================
-----BEGIN CERTIFICATE-----
MIIDdzCCAl+gAwIBAgIIXDPLYixfszIwDQYJKoZIhvcNAQELBQAwPDEeMBwGA1UEAwwVQXRvcyBU
cnVzdGVkUm9vdCAyMDExMQ0wCwYDVQQKDARBdG9zMQswCQYDVQQGEwJERTAeFw0xMTA3MDcxNDU4
MzBaFw0zMDEyMzEyMzU5NTlaMDwxHjAcBgNVBAMMFUF0b3MgVHJ1c3RlZFJvb3QgMjAxMTENMAsG
A1UECgwEQXRvczELMAkGA1UEBhMCREUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCV
hTuXbyo7LjvPpvMpNb7PGKw+qtn4TaA+Gke5vJrf8v7MPkfoepbCJI419KkM/IL9bcFyYie96mvr
54rMVD6QUM+A1JX76LWC1BTFtqlVJVfbsVD2sGBkWXppzwO3bw2+yj5vdHLqqjAqc2K+SZFhyBH+
DgMq92og3AIVDV4VavzjgsG1xZ1kCWyjWZgHJ8cblithdHFsQ/H3NYkQ4J7sVaE3IqKHBAUsR320
HLliKWYoyrfhk/WklAOZuXCFteZI6o1Q/NnezG8HDt0Lcp2AMBYHlT8oDv3FdU9T1nSatCQujgKR
z3bFmx5VdJx4IbHwLfELn8LVlhgf8FQieowHAgMBAAGjfTB7MB0GA1UdDgQWBBSnpQaxLKYJYO7R
l+lwrrw7GWzbITAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFKelBrEspglg7tGX6XCuvDsZ
bNshMBgGA1UdIAQRMA8wDQYLKwYBBAGwLQMEAQEwDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEB
CwUAA4IBAQAmdzTblEiGKkGdLD4GkGDEjKwLVLgfuXvTBznk+j57sj1O7Z8jvZfza1zv7v1Apt+h
k6EKhqzvINB5Ab149xnYJDE0BAGmuhWawyfc2E8PzBhj/5kPDpFrdRbhIfzYJsdHt6bPWHJxfrrh
TZVHO8mvbaG0weyJ9rQPOLXiZNwlz6bb65pcmaHFCN795trV1lpFDMS3wrUU77QR/w4VtfX128a9
61qn8FYiqTxlVMYVqL2Gns2Dlmh6cYGJ4Qvh6hEbaAjMaZ7snkGeRDImeuKHCnE96+RapNLbxc3G
3mB/ufNPRJLvKrcYPqcZ2Qt9sTdBQrC6YB3y/gkRsPCHe6ed
-----END CERTIFICATE-----

QuoVadis Root CA 1 G3
=====================
-----BEGIN CERTIFICATE-----
MIIFYDCCA0igAwIBAgIUeFhfLq0sGUvjNwc1NBMotZbUZZMwDQYJKoZIhvcNAQELBQAwSDELMAkG
A1UEBhMCQk0xGTAXBgNVBAoTEFF1b1ZhZGlzIExpbWl0ZWQxHjAcBgNVBAMTFVF1b1ZhZGlzIFJv
b3QgQ0EgMSBHMzAeFw0xMjAxMTIxNzI3NDRaFw00MjAxMTIxNzI3NDRaMEgxCzAJBgNVBAYTAkJN
MRkwFwYDVQQKExBRdW9WYWRpcyBMaW1pdGVkMR4wHAYDVQQDExVRdW9WYWRpcyBSb290IENBIDEg
RzMwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCgvlAQjunybEC0BJyFuTHK3C3kEakE
PBtVwedYMB0ktMPvhd6MLOHBPd+C5k+tR4ds7FtJwUrVu4/sh6x/gpqG7D0DmVIB0jWerNrwU8lm
PNSsAgHaJNM7qAJGr6Qc4/hzWHa39g6QDbXwz8z6+cZM5cOGMAqNF34168Xfuw6cwI2H44g4hWf6
Pser4BOcBRiYz5P1sZK0/CPTz9XEJ0ngnjybCKOLXSoh4Pw5qlPafX7PGglTvF0FBM+hSo+LdoIN
ofjSxxR3W5A2B4GbPgb6Ul5jxaYA/qXpUhtStZI5cgMJYr2wYBZupt0lwgNm3fME0UDiTouG9G/l
g6AnhF4EwfWQvTA9xO+oabw4m6SkltFi2mnAAZauy8RRNOoMqv8hjlmPSlzkYZqn0ukqeI1RPToV
7qJZjqlc3sX5kCLliEVx3ZGZbHqfPT2YfF72vhZooF6uCyP8Wg+qInYtyaEQHeTTRCOQiJ/GKubX
9ZqzWB4vMIkIG1SitZgj7Ah3HJVdYdHLiZxfokqRmu8hqkkWCKi9YSgxyXSthfbZxbGL0eUQMk1f
iyA6PEkfM4VZDdvLCXVDaXP7a3F98N/ETH3Goy7IlXnLc6KOTk0k+17kBL5yG6YnLUlamXrXXAkg
t3+UuU/xDRxeiEIbEbfnkduebPRq34wGmAOtzCjvpUfzUwIDAQABo0IwQDAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUo5fW816iEOGrRZ88F2Q87gFwnMwwDQYJKoZI
hvcNAQELBQADggIBABj6W3X8PnrHX3fHyt/PX8MSxEBd1DKquGrX1RUVRpgjpeaQWxiZTOOtQqOC
MTaIzen7xASWSIsBx40Bz1szBpZGZnQdT+3Btrm0DWHMY37XLneMlhwqI2hrhVd2cDMT/uFPpiN3
GPoajOi9ZcnPP/TJF9zrx7zABC4tRi9pZsMbj/7sPtPKlL92CiUNqXsCHKnQO18LwIE6PWThv6ct
Tr1NxNgpxiIY0MWscgKCP6o6ojoilzHdCGPDdRS5YCgtW2jgFqlmgiNR9etT2DGbe+m3nUvriBbP
+V04ikkwj+3x6xn0dxoxGE1nVGwvb2X52z3sIexe9PSLymBlVNFxZPT5pqOBMzYzcfCkeF9OrYMh
3jRJjehZrJ3ydlo28hP0r+AJx2EqbPfgna67hkooby7utHnNkDPDs3b69fBsnQGQ+p6Q9pxyz0fa
wx/kNSBT8lTR32GDpgLiJTjehTItXnOQUl1CxM49S+H5GYQd1aJQzEH7QRTDvdbJWqNjZgKAvQU6
O0ec7AAmTPWIUb+oI38YB7AL7YsmoWTTYUrrXJ/es69nA7Mf3W1daWhpq1467HxpvMc7hU6eFbm0
FU/DlXpY18ls6Wy58yljXrQs8C097Vpl4KlbQMJImYFtnh8GKjwStIsPm6Ik8KaN1nrgS7ZklmOV
hMJKzRwuJIczYOXD
-----END CERTIFICATE-----

QuoVadis Root CA 2 G3
=====================
-----BEGIN CERTIFICATE-----
MIIFYDCCA0igAwIBAgIURFc0JFuBiZs18s64KztbpybwdSgwDQYJKoZIhvcNAQELBQAwSDELMAkG
A1UEBhMCQk0xGTAXBgNVBAoTEFF1b1ZhZGlzIExpbWl0ZWQxHjAcBgNVBAMTFVF1b1ZhZGlzIFJv
b3QgQ0EgMiBHMzAeFw0xMjAxMTIxODU5MzJaFw00MjAxMTIxODU5MzJaMEgxCzAJBgNVBAYTAkJN
MRkwFwYDVQQKExBRdW9WYWRpcyBMaW1pdGVkMR4wHAYDVQQDExVRdW9WYWRpcyBSb290IENBIDIg
RzMwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQChriWyARjcV4g/Ruv5r+LrI3HimtFh
ZiFfqq8nUeVuGxbULX1QsFN3vXg6YOJkApt8hpvWGo6t/x8Vf9WVHhLL5hSEBMHfNrMWn4rjyduY
NM7YMxcoRvynyfDStNVNCXJJ+fKH46nafaF9a7I6JaltUkSs+L5u+9ymc5GQYaYDFCDy54ejiK2t
oIz/pgslUiXnFgHVy7g1gQyjO/Dh4fxaXc6AcW34Sas+O7q414AB+6XrW7PFXmAqMaCvN+ggOp+o
MiwMzAkd056OXbxMmO7FGmh77FOm6RQ1o9/NgJ8MSPsc9PG/Srj61YxxSscfrf5BmrODXfKEVu+l
V0POKa2Mq1W/xPtbAd0jIaFYAI7D0GoT7RPjEiuA3GfmlbLNHiJuKvhB1PLKFAeNilUSxmn1uIZo
L1NesNKqIcGY5jDjZ1XHm26sGahVpkUG0CM62+tlXSoREfA7T8pt9DTEceT/AFr2XK4jYIVz8eQQ
sSWu1ZK7E8EM4DnatDlXtas1qnIhO4M15zHfeiFuuDIIfR0ykRVKYnLP43ehvNURG3YBZwjgQQvD
6xVu+KQZ2aKrr+InUlYrAoosFCT5v0ICvybIxo/gbjh9Uy3l7ZizlWNof/k19N+IxWA1ksB8aRxh
lRbQ694Lrz4EEEVlWFA4r0jyWbYW8jwNkALGcC4BrTwV1wIDAQABo0IwQDAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQU7edvdlq/YOxJW8ald7tyFnGbxD0wDQYJKoZI
hvcNAQELBQADggIBAJHfgD9DCX5xwvfrs4iP4VGyvD11+ShdyLyZm3tdquXK4Qr36LLTn91nMX66
AarHakE7kNQIXLJgapDwyM4DYvmL7ftuKtwGTTwpD4kWilhMSA/ohGHqPHKmd+RCroijQ1h5fq7K
pVMNqT1wvSAZYaRsOPxDMuHBR//47PERIjKWnML2W2mWeyAMQ0GaW/ZZGYjeVYg3UQt4XAoeo0L9
x52ID8DyeAIkVJOviYeIyUqAHerQbj5hLja7NQ4nlv1mNDthcnPxFlxHBlRJAHpYErAK74X9sbgz
dWqTHBLmYF5vHX/JHyPLhGGfHoJE+V+tYlUkmlKY7VHnoX6XOuYvHxHaU4AshZ6rNRDbIl9qxV6X
U/IyAgkwo1jwDQHVcsaxfGl7w/U2Rcxhbl5MlMVerugOXou/983g7aEOGzPuVBj+D77vfoRrQ+Nw
mNtddbINWQeFFSM51vHfqSYP1kjHs6Yi9TM3WpVHn3u6GBVv/9YUZINJ0gpnIdsPNWNgKCLjsZWD
zYWm3S8P52dSbrsvhXz1SnPnxT7AvSESBT/8twNJAlvIJebiVDj1eYeMHVOyToV7BjjHLPj4sHKN
JeV3UvQDHEimUF+IIDBu8oJDqz2XhOdT+yHBTw8imoa4WSr2Rz0ZiC3oheGe7IUIarFsNMkd7Egr
O3jtZsSOeWmD3n+M
-----END CERTIFICATE-----

QuoVadis Root CA 3 G3
=====================
-----BEGIN CERTIFICATE-----
MIIFYDCCA0igAwIBAgIULvWbAiin23r/1aOp7r0DoM8Sah0wDQYJKoZIhvcNAQELBQAwSDELMAkG
A1UEBhMCQk0xGTAXBgNVBAoTEFF1b1ZhZGlzIExpbWl0ZWQxHjAcBgNVBAMTFVF1b1ZhZGlzIFJv
b3QgQ0EgMyBHMzAeFw0xMjAxMTIyMDI2MzJaFw00MjAxMTIyMDI2MzJaMEgxCzAJBgNVBAYTAkJN
MRkwFwYDVQQKExBRdW9WYWRpcyBMaW1pdGVkMR4wHAYDVQQDExVRdW9WYWRpcyBSb290IENBIDMg
RzMwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCzyw4QZ47qFJenMioKVjZ/aEzHs286
IxSR/xl/pcqs7rN2nXrpixurazHb+gtTTK/FpRp5PIpM/6zfJd5O2YIyC0TeytuMrKNuFoM7pmRL
Mon7FhY4futD4tN0SsJiCnMK3UmzV9KwCoWdcTzeo8vAMvMBOSBDGzXRU7Ox7sWTaYI+FrUoRqHe
6okJ7UO4BUaKhvVZR74bbwEhELn9qdIoyhA5CcoTNs+cra1AdHkrAj80//ogaX3T7mH1urPnMNA3
I4ZyYUUpSFlob3emLoG+B01vr87ERRORFHAGjx+f+IdpsQ7vw4kZ6+ocYfx6bIrc1gMLnia6Et3U
VDmrJqMz6nWB2i3ND0/kA9HvFZcba5DFApCTZgIhsUfei5pKgLlVj7WiL8DWM2fafsSntARE60f7
5li59wzweyuxwHApw0BiLTtIadwjPEjrewl5qW3aqDCYz4ByA4imW0aucnl8CAMhZa634RylsSqi
Md5mBPfAdOhx3v89WcyWJhKLhZVXGqtrdQtEPREoPHtht+KPZ0/l7DxMYIBpVzgeAVuNVejH38DM
dyM0SXV89pgR6y3e7UEuFAUCf+D+IOs15xGsIs5XPd7JMG0QA4XN8f+MFrXBsj6IbGB/kE+V9/Yt
rQE5BwT6dYB9v0lQ7e/JxHwc64B+27bQ3RP+ydOc17KXqQIDAQABo0IwQDAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUxhfQvKjqAkPyGwaZXSuQILnXnOQwDQYJKoZI
hvcNAQELBQADggIBADRh2Va1EodVTd2jNTFGu6QHcrxfYWLopfsLN7E8trP6KZ1/AvWkyaiTt3px
KGmPc+FSkNrVvjrlt3ZqVoAh313m6Tqe5T72omnHKgqwGEfcIHB9UqM+WXzBusnIFUBhynLWcKzS
t/Ac5IYp8M7vaGPQtSCKFWGafoaYtMnCdvvMujAWzKNhxnQT5WvvoxXqA/4Ti2Tk08HS6IT7SdEQ
TXlm66r99I0xHnAUrdzeZxNMgRVhvLfZkXdxGYFgu/BYpbWcC/ePIlUnwEsBbTuZDdQdm2NnL9Du
DcpmvJRPpq3t/O5jrFc/ZSXPsoaP0Aj/uHYUbt7lJ+yreLVTubY/6CD50qi+YUbKh4yE8/nxoGib
Ih6BJpsQBJFxwAYf3KDTuVan45gtf4Od34wrnDKOMpTwATwiKp9Dwi7DmDkHOHv8XgBCH/MyJnmD
hPbl8MFREsALHgQjDFSlTC9JxUrRtm5gDWv8a4uFJGS3iQ6rJUdbPM9+Sb3H6QrG2vd+DhcI00iX
0HGS8A85PjRqHH3Y8iKuu2n0M7SmSFXRDw4m6Oy2Cy2nhTXN/VnIn9HNPlopNLk9hM6xZdRZkZFW
dSHBd575euFgndOtBBj0fOtek49TSiIp+EgrPk2GrFt/ywaZWWDYWGWVjUTR939+J399roD1B0y2
PpxxVJkES/1Y+Zj0
-----END CERTIFICATE-----

DigiCert Assured ID Root G2
===========================
-----BEGIN CERTIFICATE-----
MIIDljCCAn6gAwIBAgIQC5McOtY5Z+pnI7/Dr5r0SzANBgkqhkiG9w0BAQsFADBlMQswCQYDVQQG
EwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSQw
IgYDVQQDExtEaWdpQ2VydCBBc3N1cmVkIElEIFJvb3QgRzIwHhcNMTMwODAxMTIwMDAwWhcNMzgw
MTE1MTIwMDAwWjBlMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQL
ExB3d3cuZGlnaWNlcnQuY29tMSQwIgYDVQQDExtEaWdpQ2VydCBBc3N1cmVkIElEIFJvb3QgRzIw
ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDZ5ygvUj82ckmIkzTz+GoeMVSAn61UQbVH
35ao1K+ALbkKz3X9iaV9JPrjIgwrvJUXCzO/GU1BBpAAvQxNEP4HteccbiJVMWWXvdMX0h5i89vq
bFCMP4QMls+3ywPgym2hFEwbid3tALBSfK+RbLE4E9HpEgjAALAcKxHad3A2m67OeYfcgnDmCXRw
VWmvo2ifv922ebPynXApVfSr/5Vh88lAbx3RvpO704gqu52/clpWcTs/1PPRCv4o76Pu2ZmvA9OP
YLfykqGxvYmJHzDNw6YuYjOuFgJ3RFrngQo8p0Quebg/BLxcoIfhG69Rjs3sLPr4/m3wOnyqi+Rn
lTGNAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBTO
w0q5mVXyuNtgv6l+vVa1lzan1jANBgkqhkiG9w0BAQsFAAOCAQEAyqVVjOPIQW5pJ6d1Ee88hjZv
0p3GeDgdaZaikmkuOGybfQTUiaWxMTeKySHMq2zNixya1r9I0jJmwYrA8y8678Dj1JGG0VDjA9tz
d29KOVPt3ibHtX2vK0LRdWLjSisCx1BL4GnilmwORGYQRI+tBev4eaymG+g3NJ1TyWGqolKvSnAW
hsI6yLETcDbYz+70CjTVW0z9B5yiutkBclzzTcHdDrEcDcRjvq30FPuJ7KJBDkzMyFdA0G4Dqs0M
jomZmWzwPDCvON9vvKO+KSAnq3T/EyJ43pdSVR6DtVQgA+6uwE9W3jfMw3+qBCe703e4YtsXfJwo
IhNzbM8m9Yop5w==
-----END CERTIFICATE-----

DigiCert Assured ID Root G3
===========================
-----BEGIN CERTIFICATE-----
MIICRjCCAc2gAwIBAgIQC6Fa+h3foLVJRK/NJKBs7DAKBggqhkjOPQQDAzBlMQswCQYDVQQGEwJV
UzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSQwIgYD
VQQDExtEaWdpQ2VydCBBc3N1cmVkIElEIFJvb3QgRzMwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1
MTIwMDAwWjBlMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSQwIgYDVQQDExtEaWdpQ2VydCBBc3N1cmVkIElEIFJvb3QgRzMwdjAQ
BgcqhkjOPQIBBgUrgQQAIgNiAAQZ57ysRGXtzbg/WPuNsVepRC0FFfLvC/8QdJ+1YlJfZn4f5dwb
RXkLzMZTCp2NXQLZqVneAlr2lSoOjThKiknGvMYDOAdfVdp+CW7if17QRSAPWXYQ1qAk8C3eNvJs
KTmjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBTL0L2p4ZgF
UaFNN6KDec6NHSrkhDAKBggqhkjOPQQDAwNnADBkAjAlpIFFAmsSS3V0T8gj43DydXLefInwz5Fy
YZ5eEJJZVrmDxxDnOOlYJjZ91eQ0hjkCMHw2U/Aw5WJjOpnitqM7mzT6HtoQknFekROn3aRukswy
1vUhZscv6pZjamVFkpUBtA==
-----END CERTIFICATE-----

DigiCert Global Root G2
=======================
-----BEGIN CERTIFICATE-----
MIIDjjCCAnagAwIBAgIQAzrx5qcRqaC7KGSxHQn65TANBgkqhkiG9w0BAQsFADBhMQswCQYDVQQG
EwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSAw
HgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBHMjAeFw0xMzA4MDExMjAwMDBaFw0zODAxMTUx
MjAwMDBaMGExCzAJBgNVBAYTAlVTMRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3
dy5kaWdpY2VydC5jb20xIDAeBgNVBAMTF0RpZ2lDZXJ0IEdsb2JhbCBSb290IEcyMIIBIjANBgkq
hkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuzfNNNx7a8myaJCtSnX/RrohCgiN9RlUyfuI2/Ou8jqJ
kTx65qsGGmvPrC3oXgkkRLpimn7Wo6h+4FR1IAWsULecYxpsMNzaHxmx1x7e/dfgy5SDN67sH0NO
3Xss0r0upS/kqbitOtSZpLYl6ZtrAGCSYP9PIUkY92eQq2EGnI/yuum06ZIya7XzV+hdG82MHauV
BJVJ8zUtluNJbd134/tJS7SsVQepj5WztCO7TG1F8PapspUwtP1MVYwnSlcUfIKdzXOS0xZKBgyM
UNGPHgm+F6HmIcr9g+UQvIOlCsRnKPZzFBQ9RnbDhxSJITRNrw9FDKZJobq7nMWxM4MphQIDAQAB
o0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQUTiJUIBiV5uNu
5g/6+rkS7QYXjzkwDQYJKoZIhvcNAQELBQADggEBAGBnKJRvDkhj6zHd6mcY1Yl9PMWLSn/pvtsr
F9+wX3N3KjITOYFnQoQj8kVnNeyIv/iPsGEMNKSuIEyExtv4NeF22d+mQrvHRAiGfzZ0JFrabA0U
WTW98kndth/Jsw1HKj2ZL7tcu7XUIOGZX1NGFdtom/DzMNU+MeKNhJ7jitralj41E6Vf8PlwUHBH
QRFXGU7Aj64GxJUTFy8bJZ918rGOmaFvE7FBcf6IKshPECBV1/MUReXgRPTqh5Uykw7+U0b6LJ3/
iyK5S9kJRaTepLiaWN0bfVKfjllDiIGknibVb63dDcY3fe0Dkhvld1927jyNxF1WW6LZZm6zNTfl
MrY=
-----END CERTIFICATE-----

DigiCert Global Root G3
=======================
-----BEGIN CERTIFICATE-----
MIICPzCCAcWgAwIBAgIQBVVWvPJepDU1w6QP1atFcjAKBggqhkjOPQQDAzBhMQswCQYDVQQGEwJV
UzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSAwHgYD
VQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBHMzAeFw0xMzA4MDExMjAwMDBaFw0zODAxMTUxMjAw
MDBaMGExCzAJBgNVBAYTAlVTMRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5k
aWdpY2VydC5jb20xIDAeBgNVBAMTF0RpZ2lDZXJ0IEdsb2JhbCBSb290IEczMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAE3afZu4q4C/sLfyHS8L6+c/MzXRq8NOrexpu80JX28MzQC7phW1FGfp4tn+6O
YwwX7Adw9c+ELkCDnOg/QW07rdOkFFk2eJ0DQ+4QE2xy3q6Ip6FrtUPOZ9wj/wMco+I+o0IwQDAP
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQUs9tIpPmhxdiuNkHMEWNp
Yim8S8YwCgYIKoZIzj0EAwMDaAAwZQIxAK288mw/EkrRLTnDCgmXc/SINoyIJ7vmiI1Qhadj+Z4y
3maTD/HMsQmP3Wyr+mt/oAIwOWZbwmSNuJ5Q3KjVSaLtx9zRSX8XAbjIho9OjIgrqJqpisXRAL34
VOKa5Vt8sycX
-----END CERTIFICATE-----

DigiCert Trusted Root G4
========================
-----BEGIN CERTIFICATE-----
MIIFkDCCA3igAwIBAgIQBZsbV56OITLiOQe9p3d1XDANBgkqhkiG9w0BAQwFADBiMQswCQYDVQQG
EwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQuY29tMSEw
HwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1
MTIwMDAwWjBiMQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwggIiMA0G
CSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC/5pBzaN675F1KPDAiMGkz7MKnJS7JIT3yithZwuEp
pz1Yq3aaza57G4QNxDAf8xukOBbrVsaXbR2rsnnyyhHS5F/WBTxSD1Ifxp4VpX6+n6lXFllVcq9o
k3DCsrp1mWpzMpTREEQQLt+C8weE5nQ7bXHiLQwb7iDVySAdYyktzuxeTsiT+CFhmzTrBcZe7Fsa
vOvJz82sNEBfsXpm7nfISKhmV1efVFiODCu3T6cw2Vbuyntd463JT17lNecxy9qTXtyOj4DatpGY
QJB5w3jHtrHEtWoYOAMQjdjUN6QuBX2I9YI+EJFwq1WCQTLX2wRzKm6RAXwhTNS8rhsDdV14Ztk6
MUSaM0C/CNdaSaTC5qmgZ92kJ7yhTzm1EVgX9yRcRo9k98FpiHaYdj1ZXUJ2h4mXaXpI8OCiEhtm
mnTK3kse5w5jrubU75KSOp493ADkRSWJtppEGSt+wJS00mFt6zPZxd9LBADMfRyVw4/3IbKyEbe7
f/LVjHAsQWCqsWMYRJUadmJ+9oCw++hkpjPRiQfhvbfmQ6QYuKZ3AeEPlAwhHbJUKSWJbOUOUlFH
dL4mrLZBdd56rF+NP8m800ERElvlEFDrMcXKchYiCd98THU/Y+whX8QgUWtvsauGi0/C1kVfnSD8
oR7FwI+isX4KJpn15GkvmB0t9dmpsh3lGwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1Ud
DwEB/wQEAwIBhjAdBgNVHQ4EFgQU7NfjgtJxXWRM3y5nP+e6mK4cD08wDQYJKoZIhvcNAQEMBQAD
ggIBALth2X2pbL4XxJEbw6GiAI3jZGgPVs93rnD5/ZpKmbnJeFwMDF/k5hQpVgs2SV1EY+CtnJYY
ZhsjDT156W1r1lT40jzBQ0CuHVD1UvyQO7uYmWlrx8GnqGikJ9yd+SeuMIW59mdNOj6PWTkiU0Tr
yF0Dyu1Qen1iIQqAyHNm0aAFYF/opbSnr6j3bTWcfFqK1qI4mfN4i/RN0iAL3gTujJtHgXINwBQy
7zBZLq7gcfJW5GqXb5JQbZaNaHqasjYUegbyJLkJEVDXCLG4iXqEI2FCKeWjzaIgQdfRnGTZ6iah
ixTXTBmyUEFxPT9NcCOGDErcgdLMMpSEDQgJlxxPwO5rIHQw0uA5NBCFIRUBCOhVMt5xSdkoF1BN
5r5N0XWs0Mr7QbhDparTwwVETyw2m+L64kW4I1NsBm9nVX9GtUw/bihaeSbSpKhil9Ie4u1Ki7wb
/UdKDd9nZn6yW0HQO+T0O/QEY+nvwlQAUaCKKsnOeMzV6ocEGLPOr0mIr/OSmbaz5mEP0oUA51Aa
5BuVnRmhuZyxm7EAHu/QD09CbMkKvO5D+jpxpchNJqU1/YldvIViHTLSoCtU7ZpXwdv6EM8Zt4tK
G48BtieVU+i2iW1bvGjUI+iLUaJW+fCmgKDWHrO8Dw9TdSmq6hN35N6MgSGtBxBHEa2HPQfRdbzP
82Z+
-----END CERTIFICATE-----

COMODO RSA Certification Authority
==================================
-----BEGIN CERTIFICATE-----
MIIF2DCCA8CgAwIBAgIQTKr5yttjb+Af907YWwOGnTANBgkqhkiG9w0BAQwFADCBhTELMAkGA1UE
BhMCR0IxGzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEaMBgG
A1UEChMRQ09NT0RPIENBIExpbWl0ZWQxKzApBgNVBAMTIkNPTU9ETyBSU0EgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkwHhcNMTAwMTE5MDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBhTELMAkGA1UEBhMC
R0IxGzAZBgNVBAgTEkdyZWF0ZXIgTWFuY2hlc3RlcjEQMA4GA1UEBxMHU2FsZm9yZDEaMBgGA1UE
ChMRQ09NT0RPIENBIExpbWl0ZWQxKzApBgNVBAMTIkNPTU9ETyBSU0EgQ2VydGlmaWNhdGlvbiBB
dXRob3JpdHkwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCR6FSS0gpWsawNJN3Fz0Rn
dJkrN6N9I3AAcbxT38T6KhKPS38QVr2fcHK3YX/JSw8Xpz3jsARh7v8Rl8f0hj4K+j5c+ZPmNHrZ
FGvnnLOFoIJ6dq9xkNfs/Q36nGz637CC9BR++b7Epi9Pf5l/tfxnQ3K9DADWietrLNPtj5gcFKt+
5eNu/Nio5JIk2kNrYrhV/erBvGy2i/MOjZrkm2xpmfh4SDBF1a3hDTxFYPwyllEnvGfDyi62a+pG
x8cgoLEfZd5ICLqkTqnyg0Y3hOvozIFIQ2dOciqbXL1MGyiKXCJ7tKuY2e7gUYPDCUZObT6Z+pUX
2nwzV0E8jVHtC7ZcryxjGt9XyD+86V3Em69FmeKjWiS0uqlWPc9vqv9JWL7wqP/0uK3pN/u6uPQL
OvnoQ0IeidiEyxPx2bvhiWC4jChWrBQdnArncevPDt09qZahSL0896+1DSJMwBGB7FY79tOi4lu3
sgQiUpWAk2nojkxl8ZEDLXB0AuqLZxUpaVICu9ffUGpVRr+goyhhf3DQw6KqLCGqR84onAZFdr+C
GCe01a60y1Dma/RMhnEw6abfFobg2P9A3fvQQoh/ozM6LlweQRGBY84YcWsr7KaKtzFcOmpH4MN5
WdYgGq/yapiqcrxXStJLnbsQ/LBMQeXtHT1eKJ2czL+zUdqnR+WEUwIDAQABo0IwQDAdBgNVHQ4E
FgQUu69+Aj36pvE8hI6t7jiY7NkyMtQwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQEMBQADggIBAArx1UaEt65Ru2yyTUEUAJNMnMvlwFTPoCWOAvn9sKIN9SCYPBMt
rFaisNZ+EZLpLrqeLppysb0ZRGxhNaKatBYSaVqM4dc+pBroLwP0rmEdEBsqpIt6xf4FpuHA1sj+
nq6PK7o9mfjYcwlYRm6mnPTXJ9OV2jeDchzTc+CiR5kDOF3VSXkAKRzH7JsgHAckaVd4sjn8OoSg
tZx8jb8uk2IntznaFxiuvTwJaP+EmzzV1gsD41eeFPfR60/IvYcjt7ZJQ3mFXLrrkguhxuhoqEwW
sRqZCuhTLJK7oQkYdQxlqHvLI7cawiiFwxv/0Cti76R7CZGYZ4wUAc1oBmpjIXUDgIiKboHGhfKp
pC3n9KUkEEeDys30jXlYsQab5xoq2Z0B15R97QNKyvDb6KkBPvVWmckejkk9u+UJueBPSZI9FoJA
zMxZxuY67RIuaTxslbH9qh17f4a+Hg4yRvv7E491f0yLS0Zj/gA0QHDBw7mh3aZw4gSzQbzpgJHq
ZJx64SIDqZxubw5lT2yHh17zbqD5daWbQOhTsiedSrnAdyGN/4fy3ryM7xfft0kL0fJuMAsaDk52
7RH89elWsn2/x20Kk4yl0MC2Hb46TpSi125sC8KKfPog88Tk5c0NqMuRkrF8hey1FGlmDoLnzc7I
LaZRfyHBNVOFBkpdn627G190
-----END CERTIFICATE-----

USERTrust RSA Certification Authority
=====================================
-----BEGIN CERTIFICATE-----
MIIF3jCCA8agAwIBAgIQAf1tMPyjylGoG7xkDjUDLTANBgkqhkiG9w0BAQwFADCBiDELMAkGA1UE
BhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQK
ExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkwHhcNMTAwMjAxMDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBiDELMAkGA1UE
BhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQK
ExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBSU0EgQ2VydGlmaWNh
dGlvbiBBdXRob3JpdHkwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCAEmUXNg7D2wiz
0KxXDXbtzSfTTK1Qg2HiqiBNCS1kCdzOiZ/MPans9s/B3PHTsdZ7NygRK0faOca8Ohm0X6a9fZ2j
Y0K2dvKpOyuR+OJv0OwWIJAJPuLodMkYtJHUYmTbf6MG8YgYapAiPLz+E/CHFHv25B+O1ORRxhFn
RghRy4YUVD+8M/5+bJz/Fp0YvVGONaanZshyZ9shZrHUm3gDwFA66Mzw3LyeTP6vBZY1H1dat//O
+T23LLb2VN3I5xI6Ta5MirdcmrS3ID3KfyI0rn47aGYBROcBTkZTmzNg95S+UzeQc0PzMsNT79uq
/nROacdrjGCT3sTHDN/hMq7MkztReJVni+49Vv4M0GkPGw/zJSZrM233bkf6c0Plfg6lZrEpfDKE
Y1WJxA3Bk1QwGROs0303p+tdOmw1XNtB1xLaqUkL39iAigmTYo61Zs8liM2EuLE/pDkP2QKe6xJM
lXzzawWpXhaDzLhn4ugTncxbgtNMs+1b/97lc6wjOy0AvzVVdAlJ2ElYGn+SNuZRkg7zJn0cTRe8
yexDJtC/QV9AqURE9JnnV4eeUB9XVKg+/XRjL7FQZQnmWEIuQxpMtPAlR1n6BB6T1CZGSlCBst6+
eLf8ZxXhyVeEHg9j1uliutZfVS7qXMYoCAQlObgOK6nyTJccBz8NUvXt7y+CDwIDAQABo0IwQDAd
BgNVHQ4EFgQUU3m/WqorSs9UgOHYm8Cd8rIDZsswDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQF
MAMBAf8wDQYJKoZIhvcNAQEMBQADggIBAFzUfA3P9wF9QZllDHPFUp/L+M+ZBn8b2kMVn54CVVeW
FPFSPCeHlCjtHzoBN6J2/FNQwISbxmtOuowhT6KOVWKR82kV2LyI48SqC/3vqOlLVSoGIG1VeCkZ
7l8wXEskEVX/JJpuXior7gtNn3/3ATiUFJVDBwn7YKnuHKsSjKCaXqeYalltiz8I+8jRRa8YFWSQ
Eg9zKC7F4iRO/Fjs8PRF/iKz6y+O0tlFYQXBl2+odnKPi4w2r78NBc5xjeambx9spnFixdjQg3IM
8WcRiQycE0xyNN+81XHfqnHd4blsjDwSXWXavVcStkNr/+XeTWYRUc+ZruwXtuhxkYzeSf7dNXGi
FSeUHM9h4ya7b6NnJSFd5t0dCy5oGzuCr+yDZ4XUmFF0sbmZgIn/f3gZXHlKYC6SQK5MNyosycdi
yA5d9zZbyuAlJQG03RoHnHcAP9Dc1ew91Pq7P8yF1m9/qS3fuQL39ZeatTXaw2ewh0qpKJ4jjv9c
J2vhsE/zB+4ALtRZh8tSQZXq9EfX7mRBVXyNWQKV3WKdwrnuWih0hKWbt5DHDAff9Yk2dDLWKMGw
sAvgnEzDHNb842m1R0aBL6KCq9NjRHDEjf8tM7qtj3u1cIiuPhnPQCjY/MiQu12ZIvVS5ljFH4gx
Q+6IHdfGjjxDah2nGN59PRbxYvnKkKj9
-----END CERTIFICATE-----

USERTrust ECC Certification Authority
=====================================
-----BEGIN CERTIFICATE-----
MIICjzCCAhWgAwIBAgIQXIuZxVqUxdJxVt7NiYDMJjAKBggqhkjOPQQDAzCBiDELMAkGA1UEBhMC
VVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQKExVU
aGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBFQ0MgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkwHhcNMTAwMjAxMDAwMDAwWhcNMzgwMTE4MjM1OTU5WjCBiDELMAkGA1UEBhMC
VVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNleSBDaXR5MR4wHAYDVQQKExVU
aGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMTJVVTRVJUcnVzdCBFQ0MgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQarFRaqfloI+d61SRvU8Za2EurxtW2
0eZzca7dnNYMYf3boIkDuAUU7FfO7l0/4iGzzvfUinngo4N+LZfQYcTxmdwlkWOrfzCjtHDix6Ez
nPO/LlxTsV+zfTJ/ijTjeXmjQjBAMB0GA1UdDgQWBBQ64QmG1M8ZwpZ2dEl23OA1xmNjmjAOBgNV
HQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNoADBlAjA2Z6EWCNzklwBB
HU6+4WMBzzuqQhFkoJ2UOQIReVx7Hfpkue4WQrO/isIJxOzksU0CMQDpKmFHjFJKS04YcPbWRNZu
9YO6bVi9JNlWSOrvxKJGgYhqOkbRqZtNyWHa0V1Xahg=
-----END CERTIFICATE-----

GlobalSign ECC Root CA - R5
===========================
-----BEGIN CERTIFICATE-----
MIICHjCCAaSgAwIBAgIRYFlJ4CYuu1X5CneKcflK2GwwCgYIKoZIzj0EAwMwUDEkMCIGA1UECxMb
R2xvYmFsU2lnbiBFQ0MgUm9vdCBDQSAtIFI1MRMwEQYDVQQKEwpHbG9iYWxTaWduMRMwEQYDVQQD
EwpHbG9iYWxTaWduMB4XDTEyMTExMzAwMDAwMFoXDTM4MDExOTAzMTQwN1owUDEkMCIGA1UECxMb
R2xvYmFsU2lnbiBFQ0MgUm9vdCBDQSAtIFI1MRMwEQYDVQQKEwpHbG9iYWxTaWduMRMwEQYDVQQD
EwpHbG9iYWxTaWduMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAER0UOlvt9Xb/pOdEh+J8LttV7HpI6
SFkc8GIxLcB6KP4ap1yztsyX50XUWPrRd21DosCHZTQKH3rd6zwzocWdTaRvQZU4f8kehOvRnkmS
h5SHDDqFSmafnVmTTZdhBoZKo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAd
BgNVHQ4EFgQUPeYpSJvqB8ohREom3m7e0oPQn1kwCgYIKoZIzj0EAwMDaAAwZQIxAOVpEslu28Yx
uglB4Zf4+/2a4n0Sye18ZNPLBSWLVtmg515dTguDnFt2KaAJJiFqYgIwcdK1j1zqO+F4CYWodZI7
yFz9SO8NdCKoCOJuxUnOxwy8p2Fp8fc74SrL+SvzZpA3
-----END CERTIFICATE-----

IdenTrust Commercial Root CA 1
==============================
-----BEGIN CERTIFICATE-----
MIIFYDCCA0igAwIBAgIQCgFCgAAAAUUjyES1AAAAAjANBgkqhkiG9w0BAQsFADBKMQswCQYDVQQG
EwJVUzESMBAGA1UEChMJSWRlblRydXN0MScwJQYDVQQDEx5JZGVuVHJ1c3QgQ29tbWVyY2lhbCBS
b290IENBIDEwHhcNMTQwMTE2MTgxMjIzWhcNMzQwMTE2MTgxMjIzWjBKMQswCQYDVQQGEwJVUzES
MBAGA1UEChMJSWRlblRydXN0MScwJQYDVQQDEx5JZGVuVHJ1c3QgQ29tbWVyY2lhbCBSb290IENB
IDEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCnUBneP5k91DNG8W9RYYKyqU+PZ4ld
hNlT3Qwo2dfw/66VQ3KZ+bVdfIrBQuExUHTRgQ18zZshq0PirK1ehm7zCYofWjK9ouuU+ehcCuz/
mNKvcbO0U59Oh++SvL3sTzIwiEsXXlfEU8L2ApeN2WIrvyQfYo3fw7gpS0l4PJNgiCL8mdo2yMKi
1CxUAGc1bnO/AljwpN3lsKImesrgNqUZFvX9t++uP0D1bVoE/c40yiTcdCMbXTMTEl3EASX2MN0C
XZ/g1Ue9tOsbobtJSdifWwLziuQkkORiT0/Br4sOdBeo0XKIanoBScy0RnnGF7HamB4HWfp1IYVl
3ZBWzvurpWCdxJ35UrCLvYf5jysjCiN2O/cz4ckA82n5S6LgTrx+kzmEB/dEcH7+B1rlsazRGMzy
NeVJSQjKVsk9+w8YfYs7wRPCTY/JTw436R+hDmrfYi7LNQZReSzIJTj0+kuniVyc0uMNOYZKdHzV
WYfCP04MXFL0PfdSgvHqo6z9STQaKPNBiDoT7uje/5kdX7rL6B7yuVBgwDHTc+XvvqDtMwt0viAg
xGds8AgDelWAf0ZOlqf0Hj7h9tgJ4TNkK2PXMl6f+cB7D3hvl7yTmvmcEpB4eoCHFddydJxVdHix
uuFucAS6T6C6aMN7/zHwcz09lCqxC0EOoP5NiGVreTO01wIDAQABo0IwQDAOBgNVHQ8BAf8EBAMC
AQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU7UQZwNPwBovupHu+QucmVMiONnYwDQYJKoZI
hvcNAQELBQADggIBAA2ukDL2pkt8RHYZYR4nKM1eVO8lvOMIkPkp165oCOGUAFjvLi5+U1KMtlwH
6oi6mYtQlNeCgN9hCQCTrQ0U5s7B8jeUeLBfnLOic7iPBZM4zY0+sLj7wM+x8uwtLRvM7Kqas6pg
ghstO8OEPVeKlh6cdbjTMM1gCIOQ045U8U1mwF10A0Cj7oV+wh93nAbowacYXVKV7cndJZ5t+qnt
ozo00Fl72u1Q8zW/7esUTTHHYPTa8Yec4kjixsU3+wYQ+nVZZjFHKdp2mhzpgq7vmrlR94gjmmmV
YjzlVYA211QC//G5Xc7UI2/YRYRKW2XviQzdFKcgyxilJbQN+QHwotL0AMh0jqEqSI5l2xPE4iUX
feu+h1sXIFRRk0pTAwvsXcoz7WL9RccvW9xYoIA55vrX/hMUpu09lEpCdNTDd1lzzY9GvlU47/ro
kTLql1gEIt44w8y8bckzOmoKaT+gyOpyj4xjhiO9bTyWnpXgSUyqorkqG5w2gXjtw+hG4iZZRHUe
2XWJUc0QhJ1hYMtd+ZciTY6Y5uN/9lu7rs3KSoFrXgvzUeF0K+l+J6fZmUlO+KWA2yUPHGNiiskz
Z2s8EIPGrd6ozRaOjfAHN3Gf8qv8QfXBi+wAN10J5U6A7/qxXDgGpRtK4dw4LTzcqx+QGtVKnO7R
cGzM7vRX+Bi6hG6H
-----END CERTIFICATE-----

IdenTrust Public Sector Root CA 1
=================================
-----BEGIN CERTIFICATE-----
MIIFZjCCA06gAwIBAgIQCgFCgAAAAUUjz0Z8AAAAAjANBgkqhkiG9w0BAQsFADBNMQswCQYDVQQG
EwJVUzESMBAGA1UEChMJSWRlblRydXN0MSowKAYDVQQDEyFJZGVuVHJ1c3QgUHVibGljIFNlY3Rv
ciBSb290IENBIDEwHhcNMTQwMTE2MTc1MzMyWhcNMzQwMTE2MTc1MzMyWjBNMQswCQYDVQQGEwJV
UzESMBAGA1UEChMJSWRlblRydXN0MSowKAYDVQQDEyFJZGVuVHJ1c3QgUHVibGljIFNlY3RvciBS
b290IENBIDEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC2IpT8pEiv6EdrCvsnduTy
P4o7ekosMSqMjbCpwzFrqHd2hCa2rIFCDQjrVVi7evi8ZX3yoG2LqEfpYnYeEe4IFNGyRBb06tD6
Hi9e28tzQa68ALBKK0CyrOE7S8ItneShm+waOh7wCLPQ5CQ1B5+ctMlSbdsHyo+1W/CD80/HLaXI
rcuVIKQxKFdYWuSNG5qrng0M8gozOSI5Cpcu81N3uURF/YTLNiCBWS2ab21ISGHKTN9T0a9SvESf
qy9rg3LvdYDaBjMbXcjaY8ZNzaxmMc3R3j6HEDbhuaR672BQssvKplbgN6+rNBM5Jeg5ZuSYeqoS
mJxZZoY+rfGwyj4GD3vwEUs3oERte8uojHH01bWRNszwFcYr3lEXsZdMUD2xlVl8BX0tIdUAvwFn
ol57plzy9yLxkA2T26pEUWbMfXYD62qoKjgZl3YNa4ph+bz27nb9cCvdKTz4Ch5bQhyLVi9VGxyh
LrXHFub4qjySjmm2AcG1hp2JDws4lFTo6tyePSW8Uybt1as5qsVATFSrsrTZ2fjXctscvG29ZV/v
iDUqZi/u9rNl8DONfJhBaUYPQxxp+pu10GFqzcpL2UyQRqsVWaFHVCkugyhfHMKiq3IXAAaOReyL
4jM9f9oZRORicsPfIsbyVtTdX5Vy7W1f90gDW/3FKqD2cyOEEBsB5wIDAQABo0IwQDAOBgNVHQ8B
Af8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU43HgntinQtnbcZFrlJPrw6PRFKMw
DQYJKoZIhvcNAQELBQADggIBAEf63QqwEZE4rU1d9+UOl1QZgkiHVIyqZJnYWv6IAcVYpZmxI1Qj
t2odIFflAWJBF9MJ23XLblSQdf4an4EKwt3X9wnQW3IV5B4Jaj0z8yGa5hV+rVHVDRDtfULAj+7A
mgjVQdZcDiFpboBhDhXAuM/FSRJSzL46zNQuOAXeNf0fb7iAaJg9TaDKQGXSc3z1i9kKlT/YPyNt
GtEqJBnZhbMX73huqVjRI9PHE+1yJX9dsXNw0H8GlwmEKYBhHfpe/3OsoOOJuBxxFcbeMX8S3OFt
m6/n6J91eEyrRjuazr8FGF1NFTwWmhlQBJqymm9li1JfPFgEKCXAZmExfrngdbkaqIHWchezxQMx
NRF4eKLg6TCMf4DfWN88uieW4oA0beOY02QnrEh+KHdcxiVhJfiFDGX6xDIvpZgF5PgLZxYWxoK4
Mhn5+bl53B/N66+rDt0b20XkeucC4pVd/GnwU2lhlXV5C15V5jgclKlZM57IcXR5f1GJtshquDDI
ajjDbp7hNxbqBWJMWxJH7ae0s1hWx0nzfxJoCTFx8G34Tkf71oXuxVhAGaQdp/lLQzfcaFpPz+vC
ZHTetBXZ9FRUGi8c15dxVJCO2SCdUyt/q4/i6jC8UDfv8Ue1fXwsBOxonbRJRBD0ckscZOf85muQ
3Wl9af0AVqW3rLatt8o+Ae+c
-----END CERTIFICATE-----

CFCA EV ROOT
============
-----BEGIN CERTIFICATE-----
MIIFjTCCA3WgAwIBAgIEGErM1jANBgkqhkiG9w0BAQsFADBWMQswCQYDVQQGEwJDTjEwMC4GA1UE
CgwnQ2hpbmEgRmluYW5jaWFsIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRUwEwYDVQQDDAxDRkNB
IEVWIFJPT1QwHhcNMTIwODA4MDMwNzAxWhcNMjkxMjMxMDMwNzAxWjBWMQswCQYDVQQGEwJDTjEw
MC4GA1UECgwnQ2hpbmEgRmluYW5jaWFsIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRUwEwYDVQQD
DAxDRkNBIEVWIFJPT1QwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDXXWvNED8fBVnV
BU03sQ7smCuOFR36k0sXgiFxEFLXUWRwFsJVaU2OFW2fvwwbwuCjZ9YMrM8irq93VCpLTIpTUnrD
7i7es3ElweldPe6hL6P3KjzJIx1qqx2hp/Hz7KDVRM8Vz3IvHWOX6Jn5/ZOkVIBMUtRSqy5J35DN
uF++P96hyk0g1CXohClTt7GIH//62pCfCqktQT+x8Rgp7hZZLDRJGqgG16iI0gNyejLi6mhNbiyW
ZXvKWfry4t3uMCz7zEasxGPrb382KzRzEpR/38wmnvFyXVBlWY9ps4deMm/DGIq1lY+wejfeWkU7
xzbh72fROdOXW3NiGUgthxwG+3SYIElz8AXSG7Ggo7cbcNOIabla1jj0Ytwli3i/+Oh+uFzJlU9f
py25IGvPa931DfSCt/SyZi4QKPaXWnuWFo8BGS1sbn85WAZkgwGDg8NNkt0yxoekN+kWzqotaK8K
gWU6cMGbrU1tVMoqLUuFG7OA5nBFDWteNfB/O7ic5ARwiRIlk9oKmSJgamNgTnYGmE69g60dWIol
hdLHZR4tjsbftsbhf4oEIRUpdPA+nJCdDC7xij5aqgwJHsfVPKPtl8MeNPo4+QgO48BdK4PRVmrJ
tqhUUy54Mmc9gn900PvhtgVguXDbjgv5E1hvcWAQUhC5wUEJ73IfZzF4/5YFjQIDAQABo2MwYTAf
BgNVHSMEGDAWgBTj/i39KNALtbq2osS/BqoFjJP7LzAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB
/wQEAwIBBjAdBgNVHQ4EFgQU4/4t/SjQC7W6tqLEvwaqBYyT+y8wDQYJKoZIhvcNAQELBQADggIB
ACXGumvrh8vegjmWPfBEp2uEcwPenStPuiB/vHiyz5ewG5zz13ku9Ui20vsXiObTej/tUxPQ4i9q
ecsAIyjmHjdXNYmEwnZPNDatZ8POQQaIxffu2Bq41gt/UP+TqhdLjOztUmCypAbqTuv0axn96/Ua
4CUqmtzHQTb3yHQFhDmVOdYLO6Qn+gjYXB74BGBSESgoA//vU2YApUo0FmZ8/Qmkrp5nGm9BC2sG
E5uPhnEFtC+NiWYzKXZUmhH4J/qyP5Hgzg0b8zAarb8iXRvTvyUFTeGSGn+ZnzxEk8rUQElsgIfX
BDrDMlI1Dlb4pd19xIsNER9Tyx6yF7Zod1rg1MvIB671Oi6ON7fQAUtDKXeMOZePglr4UeWJoBjn
aH9dCi77o0cOPaYjesYBx4/IXr9tgFa+iiS6M+qf4TIRnvHST4D2G0CvOJ4RUHlzEhLN5mydLIhy
PDCBBpEi6lmt2hkuIsKNuYyH4Ga8cyNfIWRjgEj1oDwYPZTISEEdQLpe/v5WOaHIz16eGWRGENoX
kbcFgKyLmZJ956LYBws2J+dIeWCKw9cTXPhyQN9Ky8+ZAAoACxGV2lZFA4gKn2fQ1XmxqI1AbQ3C
ekD6819kR5LLU7m7Wc5P/dAVUwHY3+vZ5nbv0CO7O6l5s9UCKc2Jo5YPSjXnTkLAdc0Hz+Ys63su
-----END CERTIFICATE-----

OISTE WISeKey Global Root GB CA
===============================
-----BEGIN CERTIFICATE-----
MIIDtTCCAp2gAwIBAgIQdrEgUnTwhYdGs/gjGvbCwDANBgkqhkiG9w0BAQsFADBtMQswCQYDVQQG
EwJDSDEQMA4GA1UEChMHV0lTZUtleTEiMCAGA1UECxMZT0lTVEUgRm91bmRhdGlvbiBFbmRvcnNl
ZDEoMCYGA1UEAxMfT0lTVEUgV0lTZUtleSBHbG9iYWwgUm9vdCBHQiBDQTAeFw0xNDEyMDExNTAw
MzJaFw0zOTEyMDExNTEwMzFaMG0xCzAJBgNVBAYTAkNIMRAwDgYDVQQKEwdXSVNlS2V5MSIwIAYD
VQQLExlPSVNURSBGb3VuZGF0aW9uIEVuZG9yc2VkMSgwJgYDVQQDEx9PSVNURSBXSVNlS2V5IEds
b2JhbCBSb290IEdCIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Be3HEokKtaX
scriHvt9OO+Y9bI5mE4nuBFde9IllIiCFSZqGzG7qFshISvYD06fWvGxWuR51jIjK+FTzJlFXHtP
rby/h0oLS5daqPZI7H17Dc0hBt+eFf1Biki3IPShehtX1F1Q/7pn2COZH8g/497/b1t3sWtuuMlk
9+HKQUYOKXHQuSP8yYFfTvdv37+ErXNku7dCjmn21HYdfp2nuFeKUWdy19SouJVUQHMD9ur06/4o
Qnc/nSMbsrY9gBQHTC5P99UKFg29ZkM3fiNDecNAhvVMKdqOmq0NpQSHiB6F4+lT1ZvIiwNjeOvg
GUpuuy9rM2RYk61pv48b74JIxwIDAQABo1EwTzALBgNVHQ8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB
/zAdBgNVHQ4EFgQUNQ/INmNe4qPs+TtmFc5RUuORmj0wEAYJKwYBBAGCNxUBBAMCAQAwDQYJKoZI
hvcNAQELBQADggEBAEBM+4eymYGQfp3FsLAmzYh7KzKNbrghcViXfa43FK8+5/ea4n32cZiZBKpD
dHij40lhPnOMTZTg+XHEthYOU3gf1qKHLwI5gSk8rxWYITD+KJAAjNHhy/peyP34EEY7onhCkRd0
VQreUGdNZtGn//3ZwLWoo4rOZvUPQ82nK1d7Y0Zqqi5S2PTt4W2tKZB4SLrhI6qjiey1q5bAtEui
HZeeevJuQHHfaPFlTc58Bd9TZaml8LGXBHAVRgOY1NK/VLSgWH1Sb9pWJmLU2NuJMW8c8CLC02Ic
Nc1MaRVUGpCY3useX8p3x8uOPUNpnJpY0CQ73xtAln41rYHHTnG6iBM=
-----END CERTIFICATE-----

SZAFIR ROOT CA2
===============
-----BEGIN CERTIFICATE-----
MIIDcjCCAlqgAwIBAgIUPopdB+xV0jLVt+O2XwHrLdzk1uQwDQYJKoZIhvcNAQELBQAwUTELMAkG
A1UEBhMCUEwxKDAmBgNVBAoMH0tyYWpvd2EgSXpiYSBSb3psaWN6ZW5pb3dhIFMuQS4xGDAWBgNV
BAMMD1NaQUZJUiBST09UIENBMjAeFw0xNTEwMTkwNzQzMzBaFw0zNTEwMTkwNzQzMzBaMFExCzAJ
BgNVBAYTAlBMMSgwJgYDVQQKDB9LcmFqb3dhIEl6YmEgUm96bGljemVuaW93YSBTLkEuMRgwFgYD
VQQDDA9TWkFGSVIgUk9PVCBDQTIwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC3vD5Q
qEvNQLXOYeeWyrSh2gwisPq1e3YAd4wLz32ohswmUeQgPYUM1ljj5/QqGJ3a0a4m7utT3PSQ1hNK
DJA8w/Ta0o4NkjrcsbH/ON7Dui1fgLkCvUqdGw+0w8LBZwPd3BucPbOw3gAeqDRHu5rr/gsUvTaE
2g0gv/pby6kWIK05YO4vdbbnl5z5Pv1+TW9NL++IDWr63fE9biCloBK0TXC5ztdyO4mTp4CEHCdJ
ckm1/zuVnsHMyAHs6A6KCpbns6aH5db5BSsNl0BwPLqsdVqc1U2dAgrSS5tmS0YHF2Wtn2yIANwi
ieDhZNRnvDF5YTy7ykHNXGoAyDw4jlivAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P
AQH/BAQDAgEGMB0GA1UdDgQWBBQuFqlKGLXLzPVvUPMjX/hd56zwyDANBgkqhkiG9w0BAQsFAAOC
AQEAtXP4A9xZWx126aMqe5Aosk3AM0+qmrHUuOQn/6mWmc5G4G18TKI4pAZw8PRBEew/R40/cof5
O/2kbytTAOD/OblqBw7rHRz2onKQy4I9EYKL0rufKq8h5mOGnXkZ7/e7DDWQw4rtTw/1zBLZpD67
oPwglV9PJi8RI4NOdQcPv5vRtB3pEAT+ymCPoky4rc/hkA/NrgrHXXu3UNLUYfrVFdvXn4dRVOul
4+vJhaAlIDf7js4MNIThPIGyd05DpYhfhmehPea0XGG2Ptv+tyjFogeutcrKjSoS75ftwjCkySp6
+/NNIxuZMzSgLvWpCz/UXeHPhJ/iGcJfitYgHuNztw==
-----END CERTIFICATE-----

Certum Trusted Network CA 2
===========================
-----BEGIN CERTIFICATE-----
MIIF0jCCA7qgAwIBAgIQIdbQSk8lD8kyN/yqXhKN6TANBgkqhkiG9w0BAQ0FADCBgDELMAkGA1UE
BhMCUEwxIjAgBgNVBAoTGVVuaXpldG8gVGVjaG5vbG9naWVzIFMuQS4xJzAlBgNVBAsTHkNlcnR1
bSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTEkMCIGA1UEAxMbQ2VydHVtIFRydXN0ZWQgTmV0d29y
ayBDQSAyMCIYDzIwMTExMDA2MDgzOTU2WhgPMjA0NjEwMDYwODM5NTZaMIGAMQswCQYDVQQGEwJQ
TDEiMCAGA1UEChMZVW5pemV0byBUZWNobm9sb2dpZXMgUy5BLjEnMCUGA1UECxMeQ2VydHVtIENl
cnRpZmljYXRpb24gQXV0aG9yaXR5MSQwIgYDVQQDExtDZXJ0dW0gVHJ1c3RlZCBOZXR3b3JrIENB
IDIwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC9+Xj45tWADGSdhhuWZGc/IjoedQF9
7/tcZ4zJzFxrqZHmuULlIEub2pt7uZld2ZuAS9eEQCsn0+i6MLs+CRqnSZXvK0AkwpfHp+6bJe+o
CgCXhVqqndwpyeI1B+twTUrWwbNWuKFBOJvR+zF/j+Bf4bE/D44WSWDXBo0Y+aomEKsq09DRZ40b
Rr5HMNUuctHFY9rnY3lEfktjJImGLjQ/KUxSiyqnwOKRKIm5wFv5HdnnJ63/mgKXwcZQkpsCLL2p
uTRZCr+ESv/f/rOf69me4Jgj7KZrdxYq28ytOxykh9xGc14ZYmhFV+SQgkK7QtbwYeDBoz1mo130
GO6IyY0XRSmZMnUCMe4pJshrAua1YkV/NxVaI2iJ1D7eTiew8EAMvE0Xy02isx7QBlrd9pPPV3WZ
9fqGGmd4s7+W/jTcvedSVuWz5XV710GRBdxdaeOVDUO5/IOWOZV7bIBaTxNyxtd9KXpEulKkKtVB
Rgkg/iKgtlswjbyJDNXXcPiHUv3a76xRLgezTv7QCdpw75j6VuZt27VXS9zlLCUVyJ4ueE742pye
hizKV/Ma5ciSixqClnrDvFASadgOWkaLOusm+iPJtrCBvkIApPjW/jAux9JG9uWOdf3yzLnQh1vM
BhBgu4M1t15n3kfsmUjxpKEV/q2MYo45VU85FrmxY53/twIDAQABo0IwQDAPBgNVHRMBAf8EBTAD
AQH/MB0GA1UdDgQWBBS2oVQ5AsOgP46KvPrU+Bym0ToO/TAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZI
hvcNAQENBQADggIBAHGlDs7k6b8/ONWJWsQCYftMxRQXLYtPU2sQF/xlhMcQSZDe28cmk4gmb3DW
Al45oPePq5a1pRNcgRRtDoGCERuKTsZPpd1iHkTfCVn0W3cLN+mLIMb4Ck4uWBzrM9DPhmDJ2vuA
L55MYIR4PSFk1vtBHxgP58l1cb29XN40hz5BsA72udY/CROWFC/emh1auVbONTqwX3BNXuMp8SMo
clm2q8KMZiYcdywmdjWLKKdpoPk79SPdhRB0yZADVpHnr7pH1BKXESLjokmUbOe3lEu6LaTaM4tM
pkT/WjzGHWTYtTHkpjx6qFcL2+1hGsvxznN3Y6SHb0xRONbkX8eftoEq5IVIeVheO/jbAoJnwTnb
w3RLPTYe+SmTiGhbqEQZIfCn6IENLOiTNrQ3ssqwGyZ6miUfmpqAnksqP/ujmv5zMnHCnsZy4Ypo
J/HkD7TETKVhk/iXEAcqMCWpuchxuO9ozC1+9eB+D4Kob7a6bINDd82Kkhehnlt4Fj1F4jNy3eFm
ypnTycUm/Q1oBEauttmbjL4ZvrHG8hnjXALKLNhvSgfZyTXaQHXyxKcZb55CEJh15pWLYLztxRLX
is7VmFxWlgPF7ncGNf/P5O4/E2Hu29othfDNrp2yGAlFw5Khchf8R7agCyzxxN5DaAhqXzvwdmP7
zAYspsbiDrW5viSP
-----END CERTIFICATE-----

Hellenic Academic and Research Institutions RootCA 2015
=======================================================
-----BEGIN CERTIFICATE-----
MIIGCzCCA/OgAwIBAgIBADANBgkqhkiG9w0BAQsFADCBpjELMAkGA1UEBhMCR1IxDzANBgNVBAcT
BkF0aGVuczFEMEIGA1UEChM7SGVsbGVuaWMgQWNhZGVtaWMgYW5kIFJlc2VhcmNoIEluc3RpdHV0
aW9ucyBDZXJ0LiBBdXRob3JpdHkxQDA+BgNVBAMTN0hlbGxlbmljIEFjYWRlbWljIGFuZCBSZXNl
YXJjaCBJbnN0aXR1dGlvbnMgUm9vdENBIDIwMTUwHhcNMTUwNzA3MTAxMTIxWhcNNDAwNjMwMTAx
MTIxWjCBpjELMAkGA1UEBhMCR1IxDzANBgNVBAcTBkF0aGVuczFEMEIGA1UEChM7SGVsbGVuaWMg
QWNhZGVtaWMgYW5kIFJlc2VhcmNoIEluc3RpdHV0aW9ucyBDZXJ0LiBBdXRob3JpdHkxQDA+BgNV
BAMTN0hlbGxlbmljIEFjYWRlbWljIGFuZCBSZXNlYXJjaCBJbnN0aXR1dGlvbnMgUm9vdENBIDIw
MTUwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDC+Kk/G4n8PDwEXT2QNrCROnk8Zlrv
bTkBSRq0t89/TSNTt5AA4xMqKKYx8ZEA4yjsriFBzh/a/X0SWwGDD7mwX5nh8hKDgE0GPt+sr+eh
iGsxr/CL0BgzuNtFajT0AoAkKAoCFZVedioNmToUW/bLy1O8E00BiDeUJRtCvCLYjqOWXjrZMts+
6PAQZe104S+nfK8nNLspfZu2zwnI5dMK/IhlZXQK3HMcXM1AsRzUtoSMTFDPaI6oWa7CJ06CojXd
FPQf/7J31Ycvqm59JCfnxssm5uX+Zwdj2EUN3TpZZTlYepKZcj2chF6IIbjV9Cz82XBST3i4vTwr
i5WY9bPRaM8gFH5MXF/ni+X1NYEZN9cRCLdmvtNKzoNXADrDgfgXy5I2XdGj2HUb4Ysn6npIQf1F
GQatJ5lOwXBH3bWfgVMS5bGMSF0xQxfjjMZ6Y5ZLKTBOhE5iGV48zpeQpX8B653g+IuJ3SWYPZK2
fu/Z8VFRfS0myGlZYeCsargqNhEEelC9MoS+L9xy1dcdFkfkR2YgP/SWxa+OAXqlD3pk9Q0Yh9mu
iNX6hME6wGkoLfINaFGq46V3xqSQDqE3izEjR8EJCOtu93ib14L8hCCZSRm2Ekax+0VVFqmjZayc
Bw/qa9wfLgZy7IaIEuQt218FL+TwA9MmM+eAws1CoRc0CwIDAQABo0IwQDAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUcRVnyMjJvXVdctA4GGqd83EkVAswDQYJKoZI
hvcNAQELBQADggIBAHW7bVRLqhBYRjTyYtcWNl0IXtVsyIe9tC5G8jH4fOpCtZMWVdyhDBKg2mF+
D1hYc2Ryx+hFjtyp8iY/xnmMsVMIM4GwVhO+5lFc2JsKT0ucVlMC6U/2DWDqTUJV6HwbISHTGzrM
d/K4kPFox/la/vot9L/J9UUbzjgQKjeKeaO04wlshYaT/4mWJ3iBj2fjRnRUjtkNaeJK9E10A/+y
d+2VZ5fkscWrv2oj6NSU4kQoYsRL4vDY4ilrGnB+JGGTe08DMiUNRSQrlrRGar9KC/eaj8GsGsVn
82800vpzY4zvFrCopEYq+OsS7HK07/grfoxSwIuEVPkvPuNVqNxmsdnhX9izjFk0WaSrT2y7Hxjb
davYy5LNlDhhDgcGH0tGEPEVvo2FXDtKK4F5D7Rpn0lQl033DlZdwJVqwjbDG2jJ9SrcR5q+ss7F
Jej6A7na+RZukYT1HCjI/CbM1xyQVqdfbzoEvM14iQuODy+jqk+iGxI9FghAD/FGTNeqewjBCvVt
J94Cj8rDtSvK6evIIVM4pcw72Hc3MKJP2W/R8kCtQXoXxdZKNYm3QdV8hn9VTYNKpXMgwDqvkPGa
JI7ZjnHKe7iG2rKPmT4dEw0SEe7Uq/DpFXYC5ODfqiAeW2GFZECpkJcNrVPSWh2HagCXZWK0vm9q
p/UsQu0yrbYhnr68
-----END CERTIFICATE-----

Hellenic Academic and Research Institutions ECC RootCA 2015
===========================================================
-----BEGIN CERTIFICATE-----
MIICwzCCAkqgAwIBAgIBADAKBggqhkjOPQQDAjCBqjELMAkGA1UEBhMCR1IxDzANBgNVBAcTBkF0
aGVuczFEMEIGA1UEChM7SGVsbGVuaWMgQWNhZGVtaWMgYW5kIFJlc2VhcmNoIEluc3RpdHV0aW9u
cyBDZXJ0LiBBdXRob3JpdHkxRDBCBgNVBAMTO0hlbGxlbmljIEFjYWRlbWljIGFuZCBSZXNlYXJj
aCBJbnN0aXR1dGlvbnMgRUNDIFJvb3RDQSAyMDE1MB4XDTE1MDcwNzEwMzcxMloXDTQwMDYzMDEw
MzcxMlowgaoxCzAJBgNVBAYTAkdSMQ8wDQYDVQQHEwZBdGhlbnMxRDBCBgNVBAoTO0hlbGxlbmlj
IEFjYWRlbWljIGFuZCBSZXNlYXJjaCBJbnN0aXR1dGlvbnMgQ2VydC4gQXV0aG9yaXR5MUQwQgYD
VQQDEztIZWxsZW5pYyBBY2FkZW1pYyBhbmQgUmVzZWFyY2ggSW5zdGl0dXRpb25zIEVDQyBSb290
Q0EgMjAxNTB2MBAGByqGSM49AgEGBSuBBAAiA2IABJKgQehLgoRc4vgxEZmGZE4JJS+dQS8KrjVP
dJWyUWRrjWvmP3CV8AVER6ZyOFB2lQJajq4onvktTpnvLEhvTCUp6NFxW98dwXU3tNf6e3pCnGoK
Vlp8aQuqgAkkbH7BRqNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0O
BBYEFLQiC4KZJAEOnLvkDv2/+5cgk5kqMAoGCCqGSM49BAMCA2cAMGQCMGfOFmI4oqxiRaeplSTA
GiecMjvAwNW6qef4BENThe5SId6d9SWDPp5YSy/XZxMOIQIwBeF1Ad5o7SofTUwJCA3sS61kFyjn
dc5FZXIhF8siQQ6ME5g4mlRtm8rifOoCWCKR
-----END CERTIFICATE-----

ISRG Root X1
============
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAwTzELMAkGA1UE
BhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2VhcmNoIEdyb3VwMRUwEwYDVQQD
EwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQG
EwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMT
DElTUkcgUm9vdCBYMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54r
Vygch77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+0TM8ukj1
3Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6UA5/TR5d8mUgjU+g4rk8K
b4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sWT8KOEUt+zwvo/7V3LvSye0rgTBIlDHCN
Aymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyHB5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ
4Q7e2RCOFvu396j3x+UCB5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf
1b0SHzUvKBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWnOlFu
hjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTnjh8BCNAw1FtxNrQH
usEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbwqHyGO0aoSCqI3Haadr8faqU9GY/r
OPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CIrU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4G
A1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY
9umbbjANBgkqhkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ3BebYhtF8GaV
0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KKNFtY2PwByVS5uCbMiogziUwt
hDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJw
TdwJx4nLCgdNbOhdjsnvzqvHu7UrTkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nx
e5AW0wdeRlN8NwdCjNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZA
JzVcoyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq4RgqsahD
YVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPAmRGunUHBcnWEvgJBQl9n
JEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57demyPxgcYxn/eR44/KJ4EBs+lVDR3veyJ
m+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----

AC RAIZ FNMT-RCM
================
-----BEGIN CERTIFICATE-----
MIIFgzCCA2ugAwIBAgIPXZONMGc2yAYdGsdUhGkHMA0GCSqGSIb3DQEBCwUAMDsxCzAJBgNVBAYT
AkVTMREwDwYDVQQKDAhGTk1ULVJDTTEZMBcGA1UECwwQQUMgUkFJWiBGTk1ULVJDTTAeFw0wODEw
MjkxNTU5NTZaFw0zMDAxMDEwMDAwMDBaMDsxCzAJBgNVBAYTAkVTMREwDwYDVQQKDAhGTk1ULVJD
TTEZMBcGA1UECwwQQUMgUkFJWiBGTk1ULVJDTTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoC
ggIBALpxgHpMhm5/yBNtwMZ9HACXjywMI7sQmkCpGreHiPibVmr75nuOi5KOpyVdWRHbNi63URcf
qQgfBBckWKo3Shjf5TnUV/3XwSyRAZHiItQDwFj8d0fsjz50Q7qsNI1NOHZnjrDIbzAzWHFctPVr
btQBULgTfmxKo0nRIBnuvMApGGWn3v7v3QqQIecaZ5JCEJhfTzC8PhxFtBDXaEAUwED653cXeuYL
j2VbPNmaUtu1vZ5Gzz3rkQUCwJaydkxNEJY7kvqcfw+Z374jNUUeAlz+taibmSXaXvMiwzn15Cou
08YfxGyqxRxqAQVKL9LFwag0Jl1mpdICIfkYtwb1TplvqKtMUejPUBjFd8g5CSxJkjKZqLsXF3mw
WsXmo8RZZUc1g16p6DULmbvkzSDGm0oGObVo/CK67lWMK07q87Hj/LaZmtVC+nFNCM+HHmpxffnT
tOmlcYF7wk5HlqX2doWjKI/pgG6BU6VtX7hI+cL5NqYuSf+4lsKMB7ObiFj86xsc3i1w4peSMKGJ
47xVqCfWS+2QrYv6YyVZLag13cqXM7zlzced0ezvXg5KkAYmY6252TUtB7p2ZSysV4999AeU14EC
ll2jB0nVetBX+RvnU0Z1qrB5QstocQjpYL05ac70r8NWQMetUqIJ5G+GR4of6ygnXYMgrwTJbFaa
i0b1AgMBAAGjgYMwgYAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYE
FPd9xf3E6Jobd2Sn9R2gzL+HYJptMD4GA1UdIAQ3MDUwMwYEVR0gADArMCkGCCsGAQUFBwIBFh1o
dHRwOi8vd3d3LmNlcnQuZm5tdC5lcy9kcGNzLzANBgkqhkiG9w0BAQsFAAOCAgEAB5BK3/MjTvDD
nFFlm5wioooMhfNzKWtN/gHiqQxjAb8EZ6WdmF/9ARP67Jpi6Yb+tmLSbkyU+8B1RXxlDPiyN8+s
D8+Nb/kZ94/sHvJwnvDKuO+3/3Y3dlv2bojzr2IyIpMNOmqOFGYMLVN0V2Ue1bLdI4E7pWYjJ2cJ
j+F3qkPNZVEI7VFY/uY5+ctHhKQV8Xa7pO6kO8Rf77IzlhEYt8llvhjho6Tc+hj507wTmzl6NLrT
Qfv6MooqtyuGC2mDOL7Nii4LcK2NJpLuHvUBKwrZ1pebbuCoGRw6IYsMHkCtA+fdZn71uSANA+iW
+YJF1DngoABd15jmfZ5nc8OaKveri6E6FO80vFIOiZiaBECEHX5FaZNXzuvO+FB8TxxuBEOb+dY7
Ixjp6o7RTUaN8Tvkasq6+yO3m/qZASlaWFot4/nUbQ4mrcFuNLwy+AwF+mWj2zs3gyLp1txyM/1d
8iC9djwj2ij3+RvrWWTV3F9yfiD8zYm1kGdNYno/Tq0dwzn+evQoFt9B9kiABdcPUXmsEKvU7ANm
5mqwujGSQkBqvjrTcuFqN1W8rB2Vt2lh8kORdOag0wokRqEIr9baRRmW1FMdW4R58MD3R++Lj8UG
rp1MYp3/RgT408m2ECVAdf4WqslKYIYvuu8wd+RU4riEmViAqhOLUTpPSPaLtrM=
-----END CERTIFICATE-----

Amazon Root CA 1
================
-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsFADA5MQswCQYD
VQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24gUm9vdCBDQSAxMB4XDTE1
MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTELMAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpv
bjEZMBcGA1UEAxMQQW1hem9uIFJvb3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALJ4gHHKeNXjca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgH
FzZM9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qwIFAGbHrQ
gLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6VOujw5H5SNz/0egwLX0t
dHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L93FcXmn/6pUCyziKrlA4b9v7LWIbxcce
VOF34GfID5yHI9Y/QCB/IIDEgEw+OyQmjgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3
DQEBCwUAA4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDIU5PM
CCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUsN+gDS63pYaACbvXy
8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vvo/ufQJVtMVT8QtPHRh8jrdkPSHCa
2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2
xJNDd2ZhwLnoQdeXeGADbkpyrqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----

Amazon Root CA 2
================
-----BEGIN CERTIFICATE-----
MIIFQTCCAymgAwIBAgITBmyf0pY1hp8KD+WGePhbJruKNzANBgkqhkiG9w0BAQwFADA5MQswCQYD
VQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24gUm9vdCBDQSAyMB4XDTE1
MDUyNjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpv
bjEZMBcGA1UEAxMQQW1hem9uIFJvb3QgQ0EgMjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoC
ggIBAK2Wny2cSkxKgXlRmeyKy2tgURO8TW0G/LAIjd0ZEGrHJgw12MBvIITplLGbhQPDW9tK6Mj4
kHbZW0/jTOgGNk3Mmqw9DJArktQGGWCsN0R5hYGCrVo34A3MnaZMUnbqQ523BNFQ9lXg1dKmSYXp
N+nKfq5clU1Imj+uIFptiJXZNLhSGkOQsL9sBbm2eLfq0OQ6PBJTYv9K8nu+NQWpEjTj82R0Yiw9
AElaKP4yRLuH3WUnAnE72kr3H9rN9yFVkE8P7K6C4Z9r2UXTu/Bfh+08LDmG2j/e7HJV63mjrdvd
fLC6HM783k81ds8P+HgfajZRRidhW+mez/CiVX18JYpvL7TFz4QuK/0NURBs+18bvBt+xa47mAEx
kv8LV/SasrlX6avvDXbR8O70zoan4G7ptGmh32n2M8ZpLpcTnqWHsFcQgTfJU7O7f/aS0ZzQGPSS
btqDT6ZjmUyl+17vIWR6IF9sZIUVyzfpYgwLKhbcAS4y2j5L9Z469hdAlO+ekQiG+r5jqFoz7Mt0
Q5X5bGlSNscpb/xVA1wf+5+9R+vnSUeVC06JIglJ4PVhHvG/LopyboBZ/1c6+XUyo05f7O0oYtlN
c/LMgRdg7c3r3NunysV+Ar3yVAhU/bQtCSwXVEqY0VThUWcI0u1ufm8/0i2BWSlmy5A5lREedCf+
3euvAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBSw
DPBMMPQFWAJI/TPlUq9LhONmUjANBgkqhkiG9w0BAQwFAAOCAgEAqqiAjw54o+Ci1M3m9Zh6O+oA
A7CXDpO8Wqj2LIxyh6mx/H9z/WNxeKWHWc8w4Q0QshNabYL1auaAn6AFC2jkR2vHat+2/XcycuUY
+gn0oJMsXdKMdYV2ZZAMA3m3MSNjrXiDCYZohMr/+c8mmpJ5581LxedhpxfL86kSk5Nrp+gvU5LE
YFiwzAJRGFuFjWJZY7attN6a+yb3ACfAXVU3dJnJUH/jWS5E4ywl7uxMMne0nxrpS10gxdr9HIcW
xkPo1LsmmkVwXqkLN1PiRnsn/eBG8om3zEK2yygmbtmlyTrIQRNg91CMFa6ybRoVGld45pIq2WWQ
gj9sAq+uEjonljYE1x2igGOpm/HlurR8FLBOybEfdF849lHqm/osohHUqS0nGkWxr7JOcQ3AWEbW
aQbLU8uz/mtBzUF+fUwPfHJ5elnNXkoOrJupmHN5fLT0zLm4BwyydFy4x2+IoZCn9Kr5v2c69BoV
Yh63n749sSmvZ6ES8lgQGVMDMBu4Gon2nL2XA46jCfMdiyHxtN/kHNGfZQIG6lzWE7OE76KlXIx3
KadowGuuQNKotOrN8I1LOJwZmhsoVLiJkO/KdYE+HvJkJMcYr07/R54H9jVlpNMKVv/1F2Rs76gi
JUmTtt8AF9pYfl3uxRuw0dFfIRDH+fO6AgonB8Xx1sfT4PsJYGw=
-----END CERTIFICATE-----

Amazon Root CA 3
================
-----BEGIN CERTIFICATE-----
MIIBtjCCAVugAwIBAgITBmyf1XSXNmY/Owua2eiedgPySjAKBggqhkjOPQQDAjA5MQswCQYDVQQG
EwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24gUm9vdCBDQSAzMB4XDTE1MDUy
NjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZ
MBcGA1UEAxMQQW1hem9uIFJvb3QgQ0EgMzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCmXp8ZB
f8ANm+gBG1bG8lKlui2yEujSLtf6ycXYqm0fc4E7O5hrOXwzpcVOho6AF2hiRVd9RFgdszflZwjr
Zt6jQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBSrttvXBp43
rDCGB5Fwx5zEGbF4wDAKBggqhkjOPQQDAgNJADBGAiEA4IWSoxe3jfkrBqWTrBqYaGFy+uGh0Psc
eGCmQ5nFuMQCIQCcAu/xlJyzlvnrxir4tiz+OpAUFteMYyRIHN8wfdVoOw==
-----END CERTIFICATE-----

Amazon Root CA 4
================
-----BEGIN CERTIFICATE-----
MIIB8jCCAXigAwIBAgITBmyf18G7EEwpQ+Vxe3ssyBrBDjAKBggqhkjOPQQDAzA5MQswCQYDVQQG
EwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24gUm9vdCBDQSA0MB4XDTE1MDUy
NjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZ
MBcGA1UEAxMQQW1hem9uIFJvb3QgQ0EgNDB2MBAGByqGSM49AgEGBSuBBAAiA2IABNKrijdPo1MN
/sGKe0uoe0ZLY7Bi9i0b2whxIdIA6GO9mif78DluXeo9pcmBqqNbIJhFXRbb/egQbeOc4OO9X4Ri
83BkM6DLJC9wuoihKqB1+IGuYgbEgds5bimwHvouXKNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAYYwHQYDVR0OBBYEFNPsxzplbszh2naaVvuc84ZtV+WBMAoGCCqGSM49BAMDA2gA
MGUCMDqLIfG9fhGt0O9Yli/W651+kI0rz2ZVwyzjKKlwCkcO8DdZEv8tmZQoTipPNU0zWgIxAOp1
AE47xDqUEpHJWEadIRNyp4iciuRMStuW1KyLa2tJElMzrdfkviT8tQp21KW8EA==
-----END CERTIFICATE-----

TUBITAK Kamu SM SSL Kok Sertifikasi - Surum 1
=============================================
-----BEGIN CERTIFICATE-----
MIIEYzCCA0ugAwIBAgIBATANBgkqhkiG9w0BAQsFADCB0jELMAkGA1UEBhMCVFIxGDAWBgNVBAcT
D0dlYnplIC0gS29jYWVsaTFCMEAGA1UEChM5VHVya2l5ZSBCaWxpbXNlbCB2ZSBUZWtub2xvamlr
IEFyYXN0aXJtYSBLdXJ1bXUgLSBUVUJJVEFLMS0wKwYDVQQLEyRLYW11IFNlcnRpZmlrYXN5b24g
TWVya2V6aSAtIEthbXUgU00xNjA0BgNVBAMTLVRVQklUQUsgS2FtdSBTTSBTU0wgS29rIFNlcnRp
ZmlrYXNpIC0gU3VydW0gMTAeFw0xMzExMjUwODI1NTVaFw00MzEwMjUwODI1NTVaMIHSMQswCQYD
VQQGEwJUUjEYMBYGA1UEBxMPR2ViemUgLSBLb2NhZWxpMUIwQAYDVQQKEzlUdXJraXllIEJpbGlt
c2VsIHZlIFRla25vbG9qaWsgQXJhc3Rpcm1hIEt1cnVtdSAtIFRVQklUQUsxLTArBgNVBAsTJEth
bXUgU2VydGlmaWthc3lvbiBNZXJrZXppIC0gS2FtdSBTTTE2MDQGA1UEAxMtVFVCSVRBSyBLYW11
IFNNIFNTTCBLb2sgU2VydGlmaWthc2kgLSBTdXJ1bSAxMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEAr3UwM6q7a9OZLBI3hNmNe5eA027n/5tQlT6QlVZC1xl8JoSNkvoBHToP4mQ4t4y8
6Ij5iySrLqP1N+RAjhgleYN1Hzv/bKjFxlb4tO2KRKOrbEz8HdDc72i9z+SqzvBV96I01INrN3wc
wv61A+xXzry0tcXtAA9TNypN9E8Mg/uGz8v+jE69h/mniyFXnHrfA2eJLJ2XYacQuFWQfw4tJzh0
3+f92k4S400VIgLI4OD8D62K18lUUMw7D8oWgITQUVbDjlZ/iSIzL+aFCr2lqBs23tPcLG07xxO9
WSMs5uWk99gL7eqQQESolbuT1dCANLZGeA4fAJNG4e7p+exPFwIDAQABo0IwQDAdBgNVHQ4EFgQU
ZT/HiobGPN08VFw1+DrtUgxHV8gwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wDQYJ
KoZIhvcNAQELBQADggEBACo/4fEyjq7hmFxLXs9rHmoJ0iKpEsdeV31zVmSAhHqT5Am5EM2fKifh
AHe+SMg1qIGf5LgsyX8OsNJLN13qudULXjS99HMpw+0mFZx+CFOKWI3QSyjfwbPfIPP54+M638yc
lNhOT8NrF7f3cuitZjO1JVOr4PhMqZ398g26rrnZqsZr+ZO7rqu4lzwDGrpDxpa5RXI4s6ehlj2R
e37AIVNMh+3yC1SVUZPVIqUNivGTDj5UDrDYyU7c8jEyVupk+eq1nRZmQnLzf9OxMUP8pI4X8W0j
q5Rm+K37DwhuJi1/FwcJsoz7UMCflo3Ptv0AnVoUmr8CRPXBwp8iXqIPoeM=
-----END CERTIFICATE-----

GDCA TrustAUTH R5 ROOT
======================
-----BEGIN CERTIFICATE-----
MIIFiDCCA3CgAwIBAgIIfQmX/vBH6nowDQYJKoZIhvcNAQELBQAwYjELMAkGA1UEBhMCQ04xMjAw
BgNVBAoMKUdVQU5HIERPTkcgQ0VSVElGSUNBVEUgQVVUSE9SSVRZIENPLixMVEQuMR8wHQYDVQQD
DBZHRENBIFRydXN0QVVUSCBSNSBST09UMB4XDTE0MTEyNjA1MTMxNVoXDTQwMTIzMTE1NTk1OVow
YjELMAkGA1UEBhMCQ04xMjAwBgNVBAoMKUdVQU5HIERPTkcgQ0VSVElGSUNBVEUgQVVUSE9SSVRZ
IENPLixMVEQuMR8wHQYDVQQDDBZHRENBIFRydXN0QVVUSCBSNSBST09UMIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEA2aMW8Mh0dHeb7zMNOwZ+Vfy1YI92hhJCfVZmPoiC7XJjDp6L3TQs
AlFRwxn9WVSEyfFrs0yw6ehGXTjGoqcuEVe6ghWinI9tsJlKCvLriXBjTnnEt1u9ol2x8kECK62p
OqPseQrsXzrj/e+APK00mxqriCZ7VqKChh/rNYmDf1+uKU49tm7srsHwJ5uu4/Ts765/94Y9cnrr
pftZTqfrlYwiOXnhLQiPzLyRuEH3FMEjqcOtmkVEs7LXLM3GKeJQEK5cy4KOFxg2fZfmiJqwTTQJ
9Cy5WmYqsBebnh52nUpmMUHfP/vFBu8btn4aRjb3ZGM74zkYI+dndRTVdVeSN72+ahsmUPI2JgaQ
xXABZG12ZuGR224HwGGALrIuL4xwp9E7PLOR5G62xDtw8mySlwnNR30YwPO7ng/Wi64HtloPzgsM
R6flPri9fcebNaBhlzpBdRfMK5Z3KpIhHtmVdiBnaM8Nvd/WHwlqmuLMc3GkL30SgLdTMEZeS1SZ
D2fJpcjyIMGC7J0R38IC+xo70e0gmu9lZJIQDSri3nDxGGeCjGHeuLzRL5z7D9Ar7Rt2ueQ5Vfj4
oR24qoAATILnsn8JuLwwoC8N9VKejveSswoAHQBUlwbgsQfZxw9cZX08bVlX5O2ljelAU58VS6Bx
9hoh49pwBiFYFIeFd3mqgnkCAwEAAaNCMEAwHQYDVR0OBBYEFOLJQJ9NzuiaoXzPDj9lxSmIahlR
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBCwUAA4ICAQDRSVfg
p8xoWLoBDysZzY2wYUWsEe1jUGn4H3++Fo/9nesLqjJHdtJnJO29fDMylyrHBYZmDRd9FBUb1Ov9
H5r2XpdptxolpAqzkT9fNqyL7FeoPueBihhXOYV0GkLH6VsTX4/5COmSdI31R9KrO9b7eGZONn35
6ZLpBN79SWP8bfsUcZNnL0dKt7n/HipzcEYwv1ryL3ml4Y0M2fmyYzeMN2WFcGpcWwlyua1jPLHd
+PwyvzeG5LuOmCd+uh8W4XAR8gPfJWIyJyYYMoSf/wA6E7qaTfRPuBRwIrHKK5DOKcFw9C+df/KQ
HtZa37dG/OaG+svgIHZ6uqbL9XzeYqWxi+7egmaKTjowHz+Ay60nugxe19CxVsp3cbK1daFQqUBD
F8Io2c9Si1vIY9RCPqAzekYu9wogRlR+ak8x8YF+QnQ4ZXMn7sZ8uI7XpTrXmKGcjBBV09tL7ECQ
8s1uV9JiDnxXk7Gnbc2dg7sq5+W2O3FYrf3RRbxake5TFW/TRQl1brqQXR4EzzffHqhmsYzmIGrv
/EhOdJhCrylvLmrH+33RZjEizIYAfmaDDEL0vTSSwxrqT8p+ck0LcIymSLumoRT2+1hEmRSuqguT
aaApJUqlyyvdimYHFngVV3Eb7PVHhPOeMTd61X8kreS8/f3MboPoDKi3QWwH3b08hpcv0g==
-----END CERTIFICATE-----

SSL.com Root Certification Authority RSA
========================================
-----BEGIN CERTIFICATE-----
MIIF3TCCA8WgAwIBAgIIeyyb0xaAMpkwDQYJKoZIhvcNAQELBQAwfDELMAkGA1UEBhMCVVMxDjAM
BgNVBAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQKDA9TU0wgQ29ycG9yYXRpb24x
MTAvBgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eSBSU0EwHhcNMTYw
MjEyMTczOTM5WhcNNDEwMjEyMTczOTM5WjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMx
EDAOBgNVBAcMB0hvdXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NM
LmNvbSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IFJTQTCCAiIwDQYJKoZIhvcNAQEBBQAD
ggIPADCCAgoCggIBAPkP3aMrfcvQKv7sZ4Wm5y4bunfh4/WvpOz6Sl2RxFdHaxh3a3by/ZPkPQ/C
Fp4LZsNWlJ4Xg4XOVu/yFv0AYvUiCVToZRdOQbngT0aXqhvIuG5iXmmxX9sqAn78bMrzQdjt0Oj8
P2FI7bADFB0QDksZ4LtO7IZl/zbzXmcCC52GVWH9ejjt/uIZALdvoVBidXQ8oPrIJZK0bnoix/ge
oeOy3ZExqysdBP+lSgQ36YWkMyv94tZVNHwZpEpox7Ko07fKoZOI68GXvIz5HdkihCR0xwQ9aqkp
k8zruFvh/l8lqjRYyMEjVJ0bmBHDOJx+PYZspQ9AhnwC9FwCTyjLrnGfDzrIM/4RJTXq/LrFYD3Z
fBjVsqnTdXgDciLKOsMf7yzlLqn6niy2UUb9rwPW6mBo6oUWNmuF6R7As93EJNyAKoFBbZQ+yODJ
gUEAnl6/f8UImKIYLEJAs/lvOCdLToD0PYFH4Ih86hzOtXVcUS4cK38acijnALXRdMbX5J+tB5O2
UzU1/Dfkw/ZdFr4hc96SCvigY2q8lpJqPvi8ZVWb3vUNiSYE/CUapiVpy8JtynziWV+XrOvvLsi8
1xtZPCvM8hnIk2snYxnP/Okm+Mpxm3+T/jRnhE6Z6/yzeAkzcLpmpnbtG3PrGqUNxCITIJRWCk4s
bE6x/c+cCbqiM+2HAgMBAAGjYzBhMB0GA1UdDgQWBBTdBAkHovV6fVJTEpKV7jiAJQ2mWTAPBgNV
HRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFN0ECQei9Xp9UlMSkpXuOIAlDaZZMA4GA1UdDwEB/wQE
AwIBhjANBgkqhkiG9w0BAQsFAAOCAgEAIBgRlCn7Jp0cHh5wYfGVcpNxJK1ok1iOMq8bs3AD/CUr
dIWQPXhq9LmLpZc7tRiRux6n+UBbkflVma8eEdBcHadm47GUBwwyOabqG7B52B2ccETjit3E+ZUf
ijhDPwGFpUenPUayvOUiaPd7nNgsPgohyC0zrL/FgZkxdMF1ccW+sfAjRfSda/wZY52jvATGGAsl
u1OJD7OAUN5F7kR/q5R4ZJjT9ijdh9hwZXT7DrkT66cPYakylszeu+1jTBi7qUD3oFRuIIhxdRjq
erQ0cuAjJ3dctpDqhiVAq+8zD8ufgr6iIPv2tS0a5sKFsXQP+8hlAqRSAUfdSSLBv9jra6x+3uxj
MxW3IwiPxg+NQVrdjsW5j+VFP3jbutIbQLH+cU0/4IGiul607BXgk90IH37hVZkLId6Tngr75qNJ
vTYw/ud3sqB1l7UtgYgXZSD32pAAn8lSzDLKNXz1PQ/YK9f1JmzJBjSWFupwWRoyeXkLtoh/D1JI
Pb9s2KJELtFOt3JY04kTlf5Eq/jXixtunLwsoFvVagCvXzfh1foQC5ichucmj87w7G6KVwuA406y
wKBjYZC6VWg3dGq2ktufoYYitmUnDuy2n0Jg5GfCtdpBC8TTi2EbvPofkSvXRAdeuims2cXp71NI
WuuA8ShYIc2wBlX7Jz9TkHCpBB5XJ7k=
-----END CERTIFICATE-----

SSL.com Root Certification Authority ECC
========================================
-----BEGIN CERTIFICATE-----
MIICjTCCAhSgAwIBAgIIdebfy8FoW6gwCgYIKoZIzj0EAwIwfDELMAkGA1UEBhMCVVMxDjAMBgNV
BAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQKDA9TU0wgQ29ycG9yYXRpb24xMTAv
BgNVBAMMKFNTTC5jb20gUm9vdCBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eSBFQ0MwHhcNMTYwMjEy
MTgxNDAzWhcNNDEwMjEyMTgxNDAzWjB8MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMxEDAO
BgNVBAcMB0hvdXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjExMC8GA1UEAwwoU1NMLmNv
bSBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IEVDQzB2MBAGByqGSM49AgEGBSuBBAAiA2IA
BEVuqVDEpiM2nl8ojRfLliJkP9x6jh3MCLOicSS6jkm5BBtHllirLZXI7Z4INcgn64mMU1jrYor+
8FsPazFSY0E7ic3s7LaNGdM0B9y7xgZ/wkWV7Mt/qCPgCemB+vNH06NjMGEwHQYDVR0OBBYEFILR
hXMw5zUE044CkvvlpNHEIejNMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUgtGFczDnNQTT
jgKS++Wk0cQh6M0wDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMCA2cAMGQCMG/n61kRpGDPYbCW
e+0F+S8Tkdzt5fxQaxFGRrMcIQBiu77D5+jNB5n5DQtdcj7EqgIwH7y6C+IwJPt8bYBVCpk+gA0z
5Wajs6O7pdWLjwkspl1+4vAHCGht0nxpbl/f5Wpl
-----END CERTIFICATE-----

SSL.com EV Root Certification Authority RSA R2
==============================================
-----BEGIN CERTIFICATE-----
MIIF6zCCA9OgAwIBAgIIVrYpzTS8ePYwDQYJKoZIhvcNAQELBQAwgYIxCzAJBgNVBAYTAlVTMQ4w
DAYDVQQIDAVUZXhhczEQMA4GA1UEBwwHSG91c3RvbjEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9u
MTcwNQYDVQQDDC5TU0wuY29tIEVWIFJvb3QgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkgUlNBIFIy
MB4XDTE3MDUzMTE4MTQzN1oXDTQyMDUzMDE4MTQzN1owgYIxCzAJBgNVBAYTAlVTMQ4wDAYDVQQI
DAVUZXhhczEQMA4GA1UEBwwHSG91c3RvbjEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMTcwNQYD
VQQDDC5TU0wuY29tIEVWIFJvb3QgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkgUlNBIFIyMIICIjAN
BgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAjzZlQOHWTcDXtOlG2mvqM0fNTPl9fb69LT3w23jh
hqXZuglXaO1XPqDQCEGD5yhBJB/jchXQARr7XnAjssufOePPxU7Gkm0mxnu7s9onnQqG6YE3Bf7w
cXHswxzpY6IXFJ3vG2fThVUCAtZJycxa4bH3bzKfydQ7iEGonL3Lq9ttewkfokxykNorCPzPPFTO
Zw+oz12WGQvE43LrrdF9HSfvkusQv1vrO6/PgN3B0pYEW3p+pKk8OHakYo6gOV7qd89dAFmPZiw+
B6KjBSYRaZfqhbcPlgtLyEDhULouisv3D5oi53+aNxPN8k0TayHRwMwi8qFG9kRpnMphNQcAb9Zh
CBHqurj26bNg5U257J8UZslXWNvNh2n4ioYSA0e/ZhN2rHd9NCSFg83XqpyQGp8hLH94t2S42Oim
9HizVcuE0jLEeK6jj2HdzghTreyI/BXkmg3mnxp3zkyPuBQVPWKchjgGAGYS5Fl2WlPAApiiECto
RHuOec4zSnaqW4EWG7WK2NAAe15itAnWhmMOpgWVSbooi4iTsjQc2KRVbrcc0N6ZVTsj9CLg+Slm
JuwgUHfbSguPvuUCYHBBXtSuUDkiFCbLsjtzdFVHB3mBOagwE0TlBIqulhMlQg+5U8Sb/M3kHN48
+qvWBkofZ6aYMBzdLNvcGJVXZsb/XItW9XcCAwEAAaNjMGEwDwYDVR0TAQH/BAUwAwEB/zAfBgNV
HSMEGDAWgBT5YLvU49U09rj1BoAlp3PbRmmonjAdBgNVHQ4EFgQU+WC71OPVNPa49QaAJadz20Zp
qJ4wDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBCwUAA4ICAQBWs47LCp1Jjr+kxJG7ZhcFUZh1
++VQLHqe8RT6q9OKPv+RKY9ji9i0qVQBDb6Thi/5Sm3HXvVX+cpVHBK+Rw82xd9qt9t1wkclf7nx
Y/hoLVUE0fKNsKTPvDxeH3jnpaAgcLAExbf3cqfeIg29MyVGjGSSJuM+LmOW2puMPfgYCdcDzH2G
guDKBAdRUNf/ktUM79qGn5nX67evaOI5JpS6aLe/g9Pqemc9YmeuJeVy6OLk7K4S9ksrPJ/psEDz
OFSz/bdoyNrGj1E8svuR3Bznm53htw1yj+KkxKl4+esUrMZDBcJlOSgYAsOCsp0FvmXtll9ldDz7
CTUue5wT/RsPXcdtgTpWD8w74a8CLyKsRspGPKAcTNZEtF4uXBVmCeEmKf7GUmG6sXP/wwyc5Wxq
lD8UykAWlYTzWamsX0xhk23RO8yilQwipmdnRC652dKKQbNmC1r7fSOl8hqw/96bg5Qu0T/fkreR
rwU7ZcegbLHNYhLDkBvjJc40vG93drEQw/cFGsDWr3RiSBd3kmmQYRzelYB0VI8YHMPzA9C/pEN1
hlMYegouCRw2n5H9gooiS9EOUCXdywMMF8mDAAhONU2Ki+3wApRmLER/y5UnlhetCTCstnEXbosX
9hwJ1C07mKVx01QT2WDz9UtmT/rx7iASjbSsV7FFY6GsdqnC+w==
-----END CERTIFICATE-----

SSL.com EV Root Certification Authority ECC
===========================================
-----BEGIN CERTIFICATE-----
MIIClDCCAhqgAwIBAgIILCmcWxbtBZUwCgYIKoZIzj0EAwIwfzELMAkGA1UEBhMCVVMxDjAMBgNV
BAgMBVRleGFzMRAwDgYDVQQHDAdIb3VzdG9uMRgwFgYDVQQKDA9TU0wgQ29ycG9yYXRpb24xNDAy
BgNVBAMMK1NTTC5jb20gRVYgUm9vdCBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eSBFQ0MwHhcNMTYw
MjEyMTgxNTIzWhcNNDEwMjEyMTgxNTIzWjB/MQswCQYDVQQGEwJVUzEOMAwGA1UECAwFVGV4YXMx
EDAOBgNVBAcMB0hvdXN0b24xGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjE0MDIGA1UEAwwrU1NM
LmNvbSBFViBSb290IENlcnRpZmljYXRpb24gQXV0aG9yaXR5IEVDQzB2MBAGByqGSM49AgEGBSuB
BAAiA2IABKoSR5CYG/vvw0AHgyBO8TCCogbR8pKGYfL2IWjKAMTH6kMAVIbc/R/fALhBYlzccBYy
3h+Z1MzFB8gIH2EWB1E9fVwHU+M1OIzfzZ/ZLg1KthkuWnBaBu2+8KGwytAJKaNjMGEwHQYDVR0O
BBYEFFvKXuXe0oGqzagtZFG22XKbl+ZPMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUW8pe
5d7SgarNqC1kUbbZcpuX5k8wDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMCA2gAMGUCMQCK5kCJ
N+vp1RPZytRrJPOwPYdGWBrssd9v+1a6cGvHOMzosYxPD/fxZ3YOg9AeUY8CMD32IygmTMZgh5Mm
m7I1HrrW9zzRHM76JTymGoEVW/MSD2zuZYrJh6j5B+BimoxcSg==
-----END CERTIFICATE-----

GlobalSign Root CA - R6
=======================
-----BEGIN CERTIFICATE-----
MIIFgzCCA2ugAwIBAgIORea7A4Mzw4VlSOb/RVEwDQYJKoZIhvcNAQEMBQAwTDEgMB4GA1UECxMX
R2xvYmFsU2lnbiBSb290IENBIC0gUjYxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkds
b2JhbFNpZ24wHhcNMTQxMjEwMDAwMDAwWhcNMzQxMjEwMDAwMDAwWjBMMSAwHgYDVQQLExdHbG9i
YWxTaWduIFJvb3QgQ0EgLSBSNjETMBEGA1UEChMKR2xvYmFsU2lnbjETMBEGA1UEAxMKR2xvYmFs
U2lnbjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAJUH6HPKZvnsFMp7PPcNCPG0RQss
grRIxutbPK6DuEGSMxSkb3/pKszGsIhrxbaJ0cay/xTOURQh7ErdG1rG1ofuTToVBu1kZguSgMpE
3nOUTvOniX9PeGMIyBJQbUJmL025eShNUhqKGoC3GYEOfsSKvGRMIRxDaNc9PIrFsmbVkJq3MQbF
vuJtMgamHvm566qjuL++gmNQ0PAYid/kD3n16qIfKtJwLnvnvJO7bVPiSHyMEAc4/2ayd2F+4OqM
PKq0pPbzlUoSB239jLKJz9CgYXfIWHSw1CM69106yqLbnQneXUQtkPGBzVeS+n68UARjNN9rkxi+
azayOeSsJDa38O+2HBNXk7besvjihbdzorg1qkXy4J02oW9UivFyVm4uiMVRQkQVlO6jxTiWm05O
WgtH8wY2SXcwvHE35absIQh1/OZhFj931dmRl4QKbNQCTXTAFO39OfuD8l4UoQSwC+n+7o/hbguy
CLNhZglqsQY6ZZZZwPA1/cnaKI0aEYdwgQqomnUdnjqGBQCe24DWJfncBZ4nWUx2OVvq+aWh2IMP
0f/fMBH5hc8zSPXKbWQULHpYT9NLCEnFlWQaYw55PfWzjMpYrZxCRXluDocZXFSxZba/jJvcE+kN
b7gu3GduyYsRtYQUigAZcIN5kZeR1BonvzceMgfYFGM8KEyvAgMBAAGjYzBhMA4GA1UdDwEB/wQE
AwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSubAWjkxPioufi1xzWx/B/yGdToDAfBgNV
HSMEGDAWgBSubAWjkxPioufi1xzWx/B/yGdToDANBgkqhkiG9w0BAQwFAAOCAgEAgyXt6NH9lVLN
nsAEoJFp5lzQhN7craJP6Ed41mWYqVuoPId8AorRbrcWc+ZfwFSY1XS+wc3iEZGtIxg93eFyRJa0
lV7Ae46ZeBZDE1ZXs6KzO7V33EByrKPrmzU+sQghoefEQzd5Mr6155wsTLxDKZmOMNOsIeDjHfrY
BzN2VAAiKrlNIC5waNrlU/yDXNOd8v9EDERm8tLjvUYAGm0CuiVdjaExUd1URhxN25mW7xocBFym
Fe944Hn+Xds+qkxV/ZoVqW/hpvvfcDDpw+5CRu3CkwWJ+n1jez/QcYF8AOiYrg54NMMl+68KnyBr
3TsTjxKM4kEaSHpzoHdpx7Zcf4LIHv5YGygrqGytXm3ABdJ7t+uA/iU3/gKbaKxCXcPu9czc8FB1
0jZpnOZ7BN9uBmm23goJSFmH63sUYHpkqmlD75HHTOwY3WzvUy2MmeFe8nI+z1TIvWfspA9MRf/T
uTAjB0yPEL+GltmZWrSZVxykzLsViVO6LAUP5MSeGbEYNNVMnbrt9x+vJJUEeKgDu+6B5dpffItK
oZB0JaezPkvILFa9x8jvOOJckvB595yEunQtYQEgfn7R8k8HWV+LLUNS60YMlOH1Zkd5d9VUWx+t
JDfLRVpOoERIyNiwmcUVhAn21klJwGW45hpxbqCo8YLoRT5s1gLXCmeDBVrJpBA=
-----END CERTIFICATE-----

OISTE WISeKey Global Root GC CA
===============================
-----BEGIN CERTIFICATE-----
MIICaTCCAe+gAwIBAgIQISpWDK7aDKtARb8roi066jAKBggqhkjOPQQDAzBtMQswCQYDVQQGEwJD
SDEQMA4GA1UEChMHV0lTZUtleTEiMCAGA1UECxMZT0lTVEUgRm91bmRhdGlvbiBFbmRvcnNlZDEo
MCYGA1UEAxMfT0lTVEUgV0lTZUtleSBHbG9iYWwgUm9vdCBHQyBDQTAeFw0xNzA1MDkwOTQ4MzRa
Fw00MjA1MDkwOTU4MzNaMG0xCzAJBgNVBAYTAkNIMRAwDgYDVQQKEwdXSVNlS2V5MSIwIAYDVQQL
ExlPSVNURSBGb3VuZGF0aW9uIEVuZG9yc2VkMSgwJgYDVQQDEx9PSVNURSBXSVNlS2V5IEdsb2Jh
bCBSb290IEdDIENBMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAETOlQwMYPchi82PG6s4nieUqjFqdr
VCTbUf/q9Akkwwsin8tqJ4KBDdLArzHkdIJuyiXZjHWd8dvQmqJLIX4Wp2OQ0jnUsYd4XxiWD1Ab
NTcPasbc2RNNpI6QN+a9WzGRo1QwUjAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAd
BgNVHQ4EFgQUSIcUrOPDnpBgOtfKie7TrYy0UGYwEAYJKwYBBAGCNxUBBAMCAQAwCgYIKoZIzj0E
AwMDaAAwZQIwJsdpW9zV57LnyAyMjMPdeYwbY9XJUpROTYJKcx6ygISpJcBMWm1JKWB4E+J+SOtk
AjEA2zQgMgj/mkkCtojeFK9dbJlxjRo/i9fgojaGHAeCOnZT/cKi7e97sIBPWA9LUzm9
-----END CERTIFICATE-----

UCA Global G2 Root
==================
-----BEGIN CERTIFICATE-----
MIIFRjCCAy6gAwIBAgIQXd+x2lqj7V2+WmUgZQOQ7zANBgkqhkiG9w0BAQsFADA9MQswCQYDVQQG
EwJDTjERMA8GA1UECgwIVW5pVHJ1c3QxGzAZBgNVBAMMElVDQSBHbG9iYWwgRzIgUm9vdDAeFw0x
NjAzMTEwMDAwMDBaFw00MDEyMzEwMDAwMDBaMD0xCzAJBgNVBAYTAkNOMREwDwYDVQQKDAhVbmlU
cnVzdDEbMBkGA1UEAwwSVUNBIEdsb2JhbCBHMiBSb290MIICIjANBgkqhkiG9w0BAQEFAAOCAg8A
MIICCgKCAgEAxeYrb3zvJgUno4Ek2m/LAfmZmqkywiKHYUGRO8vDaBsGxUypK8FnFyIdK+35KYmT
oni9kmugow2ifsqTs6bRjDXVdfkX9s9FxeV67HeToI8jrg4aA3++1NDtLnurRiNb/yzmVHqUwCoV
8MmNsHo7JOHXaOIxPAYzRrZUEaalLyJUKlgNAQLx+hVRZ2zA+te2G3/RVogvGjqNO7uCEeBHANBS
h6v7hn4PJGtAnTRnvI3HLYZveT6OqTwXS3+wmeOwcWDcC/Vkw85DvG1xudLeJ1uK6NjGruFZfc8o
LTW4lVYa8bJYS7cSN8h8s+1LgOGN+jIjtm+3SJUIsUROhYw6AlQgL9+/V087OpAh18EmNVQg7Mc/
R+zvWr9LesGtOxdQXGLYD0tK3Cv6brxzks3sx1DoQZbXqX5t2Okdj4q1uViSukqSKwxW/YDrCPBe
KW4bHAyvj5OJrdu9o54hyokZ7N+1wxrrFv54NkzWbtA+FxyQF2smuvt6L78RHBgOLXMDj6DlNaBa
4kx1HXHhOThTeEDMg5PXCp6dW4+K5OXgSORIskfNTip1KnvyIvbJvgmRlld6iIis7nCs+dwp4wwc
OxJORNanTrAmyPPZGpeRaOrvjUYG0lZFWJo8DA+DuAUlwznPO6Q0ibd5Ei9Hxeepl2n8pndntd97
8XplFeRhVmUCAwEAAaNCMEAwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0O
BBYEFIHEjMz15DD/pQwIX4wVZyF0Ad/fMA0GCSqGSIb3DQEBCwUAA4ICAQATZSL1jiutROTL/7lo
5sOASD0Ee/ojL3rtNtqyzm325p7lX1iPyzcyochltq44PTUbPrw7tgTQvPlJ9Zv3hcU2tsu8+Mg5
1eRfB70VVJd0ysrtT7q6ZHafgbiERUlMjW+i67HM0cOU2kTC5uLqGOiiHycFutfl1qnN3e92mI0A
Ds0b+gO3joBYDic/UvuUospeZcnWhNq5NXHzJsBPd+aBJ9J3O5oUb3n09tDh05S60FdRvScFDcH9
yBIw7m+NESsIndTUv4BFFJqIRNow6rSn4+7vW4LVPtateJLbXDzz2K36uGt/xDYotgIVilQsnLAX
c47QN6MUPJiVAAwpBVueSUmxX8fjy88nZY41F7dXyDDZQVu5FLbowg+UMaeUmMxq67XhJ/UQqAHo
jhJi6IjMtX9Gl8CbEGY4GjZGXyJoPd/JxhMnq1MGrKI8hgZlb7F+sSlEmqO6SWkoaY/X5V+tBIZk
bxqgDMUIYs6Ao9Dz7GjevjPHF1t/gMRMTLGmhIrDO7gJzRSBuhjjVFc2/tsvfEehOjPI+Vg7RE+x
ygKJBJYoaMVLuCaJu9YzL1DV/pqJuhgyklTGW+Cd+V7lDSKb9triyCGyYiGqhkCyLmTTX8jjfhFn
RR8F/uOi77Oos/N9j/gMHyIfLXC0uAE0djAA5SN4p1bXUB+K+wb1whnw0A==
-----END CERTIFICATE-----

UCA Extended Validation Root
============================
-----BEGIN CERTIFICATE-----
MIIFWjCCA0KgAwIBAgIQT9Irj/VkyDOeTzRYZiNwYDANBgkqhkiG9w0BAQsFADBHMQswCQYDVQQG
EwJDTjERMA8GA1UECgwIVW5pVHJ1c3QxJTAjBgNVBAMMHFVDQSBFeHRlbmRlZCBWYWxpZGF0aW9u
IFJvb3QwHhcNMTUwMzEzMDAwMDAwWhcNMzgxMjMxMDAwMDAwWjBHMQswCQYDVQQGEwJDTjERMA8G
A1UECgwIVW5pVHJ1c3QxJTAjBgNVBAMMHFVDQSBFeHRlbmRlZCBWYWxpZGF0aW9uIFJvb3QwggIi
MA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCpCQcoEwKwmeBkqh5DFnpzsZGgdT6o+uM4AHrs
iWogD4vFsJszA1qGxliG1cGFu0/GnEBNyr7uaZa4rYEwmnySBesFK5pI0Lh2PpbIILvSsPGP2KxF
Rv+qZ2C0d35qHzwaUnoEPQc8hQ2E0B92CvdqFN9y4zR8V05WAT558aopO2z6+I9tTcg1367r3CTu
eUWnhbYFiN6IXSV8l2RnCdm/WhUFhvMJHuxYMjMR83dksHYf5BA1FxvyDrFspCqjc/wJHx4yGVMR
59mzLC52LqGj3n5qiAno8geK+LLNEOfic0CTuwjRP+H8C5SzJe98ptfRr5//lpr1kXuYC3fUfugH
0mK1lTnj8/FtDw5lhIpjVMWAtuCeS31HJqcBCF3RiJ7XwzJE+oJKCmhUfzhTA8ykADNkUVkLo4KR
el7sFsLzKuZi2irbWWIQJUoqgQtHB0MGcIfS+pMRKXpITeuUx3BNr2fVUbGAIAEBtHoIppB/TuDv
B0GHr2qlXov7z1CymlSvw4m6WC31MJixNnI5fkkE/SmnTHnkBVfblLkWU41Gsx2VYVdWf6/wFlth
WG82UBEL2KwrlRYaDh8IzTY0ZRBiZtWAXxQgXy0MoHgKaNYs1+lvK9JKBZP8nm9rZ/+I8U6laUpS
NwXqxhaN0sSZ0YIrO7o1dfdRUVjzyAfd5LQDfwIDAQABo0IwQDAdBgNVHQ4EFgQU2XQ65DA9DfcS
3H5aBZ8eNJr34RQwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAYYwDQYJKoZIhvcNAQEL
BQADggIBADaNl8xCFWQpN5smLNb7rhVpLGsaGvdftvkHTFnq88nIua7Mui563MD1sC3AO6+fcAUR
ap8lTwEpcOPlDOHqWnzcSbvBHiqB9RZLcpHIojG5qtr8nR/zXUACE/xOHAbKsxSQVBcZEhrxH9cM
aVr2cXj0lH2RC47skFSOvG+hTKv8dGT9cZr4QQehzZHkPJrgmzI5c6sq1WnIeJEmMX3ixzDx/BR4
dxIOE/TdFpS/S2d7cFOFyrC78zhNLJA5wA3CXWvp4uXViI3WLL+rG761KIcSF3Ru/H38j9CHJrAb
+7lsq+KePRXBOy5nAliRn+/4Qh8st2j1da3Ptfb/EX3C8CSlrdP6oDyp+l3cpaDvRKS+1ujl5BOW
F3sGPjLtx7dCvHaj2GU4Kzg1USEODm8uNBNA4StnDG1KQTAYI1oyVZnJF+A83vbsea0rWBmirSwi
GpWOvpaQXUJXxPkUAzUrHC1RVwinOt4/5Mi0A3PCwSaAuwtCH60NryZy2sy+s6ODWA2CxR9GUeOc
GMyNm43sSet1UNWMKFnKdDTajAshqx7qG+XH/RU+wBeq+yNuJkbL+vmxcmtpzyKEC2IPrNkZAJSi
djzULZrtBJ4tBmIQN1IchXIbJ+XMxjHsN+xjWZsLHXbMfjKaiJUINlK73nZfdklJrX+9ZSCyycEr
dhh2n1ax
-----END CERTIFICATE-----

Certigna Root CA
================
-----BEGIN CERTIFICATE-----
MIIGWzCCBEOgAwIBAgIRAMrpG4nxVQMNo+ZBbcTjpuEwDQYJKoZIhvcNAQELBQAwWjELMAkGA1UE
BhMCRlIxEjAQBgNVBAoMCURoaW15b3RpczEcMBoGA1UECwwTMDAwMiA0ODE0NjMwODEwMDAzNjEZ
MBcGA1UEAwwQQ2VydGlnbmEgUm9vdCBDQTAeFw0xMzEwMDEwODMyMjdaFw0zMzEwMDEwODMyMjda
MFoxCzAJBgNVBAYTAkZSMRIwEAYDVQQKDAlEaGlteW90aXMxHDAaBgNVBAsMEzAwMDIgNDgxNDYz
MDgxMDAwMzYxGTAXBgNVBAMMEENlcnRpZ25hIFJvb3QgQ0EwggIiMA0GCSqGSIb3DQEBAQUAA4IC
DwAwggIKAoICAQDNGDllGlmx6mQWDoyUJJV8g9PFOSbcDO8WV43X2KyjQn+Cyu3NW9sOty3tRQgX
stmzy9YXUnIo245Onoq2C/mehJpNdt4iKVzSs9IGPjA5qXSjklYcoW9MCiBtnyN6tMbaLOQdLNyz
KNAT8kxOAkmhVECe5uUFoC2EyP+YbNDrihqECB63aCPuI9Vwzm1RaRDuoXrC0SIxwoKF0vJVdlB8
JXrJhFwLrN1CTivngqIkicuQstDuI7pmTLtipPlTWmR7fJj6o0ieD5Wupxj0auwuA0Wv8HT4Ks16
XdG+RCYyKfHx9WzMfgIhC59vpD++nVPiz32pLHxYGpfhPTc3GGYo0kDFUYqMwy3OU4gkWGQwFsWq
4NYKpkDfePb1BHxpE4S80dGnBs8B92jAqFe7OmGtBIyT46388NtEbVncSVmurJqZNjBBe3YzIoej
wpKGbvlw7q6Hh5UbxHq9MfPU0uWZ/75I7HX1eBYdpnDBfzwboZL7z8g81sWTCo/1VTp2lc5ZmIoJ
lXcymoO6LAQ6l73UL77XbJuiyn1tJslV1c/DeVIICZkHJC1kJWumIWmbat10TWuXekG9qxf5kBdI
jzb5LdXF2+6qhUVB+s06RbFo5jZMm5BX7CO5hwjCxAnxl4YqKE3idMDaxIzb3+KhF1nOJFl0Mdp/
/TBt2dzhauH8XwIDAQABo4IBGjCCARYwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYw
HQYDVR0OBBYEFBiHVuBud+4kNTxOc5of1uHieX4rMB8GA1UdIwQYMBaAFBiHVuBud+4kNTxOc5of
1uHieX4rMEQGA1UdIAQ9MDswOQYEVR0gADAxMC8GCCsGAQUFBwIBFiNodHRwczovL3d3d3cuY2Vy
dGlnbmEuZnIvYXV0b3JpdGVzLzBtBgNVHR8EZjBkMC+gLaArhilodHRwOi8vY3JsLmNlcnRpZ25h
LmZyL2NlcnRpZ25hcm9vdGNhLmNybDAxoC+gLYYraHR0cDovL2NybC5kaGlteW90aXMuY29tL2Nl
cnRpZ25hcm9vdGNhLmNybDANBgkqhkiG9w0BAQsFAAOCAgEAlLieT/DjlQgi581oQfccVdV8AOIt
OoldaDgvUSILSo3L6btdPrtcPbEo/uRTVRPPoZAbAh1fZkYJMyjhDSSXcNMQH+pkV5a7XdrnxIxP
TGRGHVyH41neQtGbqH6mid2PHMkwgu07nM3A6RngatgCdTer9zQoKJHyBApPNeNgJgH60BGM+RFq
7q89w1DTj18zeTyGqHNFkIwgtnJzFyO+B2XleJINugHA64wcZr+shncBlA2c5uk5jR+mUYyZDDl3
4bSb+hxnV29qao6pK0xXeXpXIs/NX2NGjVxZOob4Mkdio2cNGJHc+6Zr9UhhcyNZjgKnvETq9Emd
8VRY+WCv2hikLyhF3HqgiIZd8zvn/yk1gPxkQ5Tm4xxvvq0OKmOZK8l+hfZx6AYDlf7ej0gcWtSS
6Cvu5zHbugRqh5jnxV/vfaci9wHYTfmJ0A6aBVmknpjZbyvKcL5kwlWj9Omvw5Ip3IgWJJk8jSaY
tlu3zM63Nwf9JtmYhST/WSMDmu2dnajkXjjO11INb9I/bbEFa0nOipFGc/T2L/Coc3cOZayhjWZS
aX5LaAzHHjcng6WMxwLkFM1JAbBzs/3GkDpv0mztO+7skb6iQ12LAEpmJURw3kAP+HwV96LOPNde
E4yBFxgX0b3xdxA61GU5wSesVywlVP+i2k+KYTlerj1KjL0=
-----END CERTIFICATE-----

emSign Root CA - G1
===================
-----BEGIN CERTIFICATE-----
MIIDlDCCAnygAwIBAgIKMfXkYgxsWO3W2DANBgkqhkiG9w0BAQsFADBnMQswCQYDVQQGEwJJTjET
MBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRl
ZDEcMBoGA1UEAxMTZW1TaWduIFJvb3QgQ0EgLSBHMTAeFw0xODAyMTgxODMwMDBaFw00MzAyMTgx
ODMwMDBaMGcxCzAJBgNVBAYTAklOMRMwEQYDVQQLEwplbVNpZ24gUEtJMSUwIwYDVQQKExxlTXVk
aHJhIFRlY2hub2xvZ2llcyBMaW1pdGVkMRwwGgYDVQQDExNlbVNpZ24gUm9vdCBDQSAtIEcxMIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAk0u76WaK7p1b1TST0Bsew+eeuGQzf2N4aLTN
LnF115sgxk0pvLZoYIr3IZpWNVrzdr3YzZr/k1ZLpVkGoZM0Kd0WNHVO8oG0x5ZOrRkVUkr+PHB1
cM2vK6sVmjM8qrOLqs1D/fXqcP/tzxE7lM5OMhbTI0Aqd7OvPAEsbO2ZLIvZTmmYsvePQbAyeGHW
DV/D+qJAkh1cF+ZwPjXnorfCYuKrpDhMtTk1b+oDafo6VGiFbdbyL0NVHpENDtjVaqSW0RM8LHhQ
6DqS0hdW5TUaQBw+jSztOd9C4INBdN+jzcKGYEho42kLVACL5HZpIQ15TjQIXhTCzLG3rdd8cIrH
hQIDAQABo0IwQDAdBgNVHQ4EFgQU++8Nhp6w492pufEhF38+/PB3KxowDgYDVR0PAQH/BAQDAgEG
MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAFn/8oz1h31xPaOfG1vR2vjTnGs2
vZupYeveFix0PZ7mddrXuqe8QhfnPZHr5X3dPpzxz5KsbEjMwiI/aTvFthUvozXGaCocV685743Q
NcMYDHsAVhzNixl03r4PEuDQqqE/AjSxcM6dGNYIAwlG7mDgfrbESQRRfXBgvKqy/3lyeqYdPV8q
+Mri/Tm3R7nrft8EI6/6nAYH6ftjk4BAtcZsCjEozgyfz7MjNYBBjWzEN3uBL4ChQEKF6dk4jeih
U80Bv2noWgbyRQuQ+q7hv53yrlc8pa6yVvSLZUDp/TGBLPQ5Cdjua6e0ph0VpZj3AYHYhX3zUVxx
iN66zB+Afko=
-----END CERTIFICATE-----

emSign ECC Root CA - G3
=======================
-----BEGIN CERTIFICATE-----
MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQDAzBrMQswCQYDVQQGEwJJTjETMBEG
A1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEg
MB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0gRzMwHhcNMTgwMjE4MTgzMDAwWhcNNDMwMjE4
MTgzMDAwWjBrMQswCQYDVQQGEwJJTjETMBEGA1UECxMKZW1TaWduIFBLSTElMCMGA1UEChMcZU11
ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAxMXZW1TaWduIEVDQyBSb290IENBIC0g
RzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQjpQy4LRL1KPOxst3iAhKAnjlfSU2fySU0WXTsuwYc
58Byr+iuL+FBVIcUqEqy6HyC5ltqtdyzdc6LBtCGI79G1Y4PPwT01xySfvalY8L1X44uT6EYGQIr
MgqCZH0Wk9GjQjBAMB0GA1UdDgQWBBR8XQKEE9TMipuBzhccLikenEhjQjAOBgNVHQ8BAf8EBAMC
AQYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAwNpADBmAjEAvvNhzwIQHWSVB7gYboiFBS+D
CBeQyh+KTOgNG3qxrdWBCUfvO6wIBHxcmbHtRwfSAjEAnbpV/KlK6O3t5nYBQnvI+GDZjVGLVTv7
jHvrZQnD+JbNR6iC8hZVdyR+EhCVBCyj
-----END CERTIFICATE-----

emSign Root CA - C1
===================
-----BEGIN CERTIFICATE-----
MIIDczCCAlugAwIBAgILAK7PALrEzzL4Q7IwDQYJKoZIhvcNAQELBQAwVjELMAkGA1UEBhMCVVMx
EzARBgNVBAsTCmVtU2lnbiBQS0kxFDASBgNVBAoTC2VNdWRocmEgSW5jMRwwGgYDVQQDExNlbVNp
Z24gUm9vdCBDQSAtIEMxMB4XDTE4MDIxODE4MzAwMFoXDTQzMDIxODE4MzAwMFowVjELMAkGA1UE
BhMCVVMxEzARBgNVBAsTCmVtU2lnbiBQS0kxFDASBgNVBAoTC2VNdWRocmEgSW5jMRwwGgYDVQQD
ExNlbVNpZ24gUm9vdCBDQSAtIEMxMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz+up
ufGZBczYKCFK83M0UYRWEPWgTywS4/oTmifQz/l5GnRfHXk5/Fv4cI7gklL35CX5VIPZHdPIWoU/
Xse2B+4+wM6ar6xWQio5JXDWv7V7Nq2s9nPczdcdioOl+yuQFTdrHCZH3DspVpNqs8FqOp099cGX
OFgFixwR4+S0uF2FHYP+eF8LRWgYSKVGczQ7/g/IdrvHGPMF0Ybzhe3nudkyrVWIzqa2kbBPrH4V
I5b2P/AgNBbeCsbEBEV5f6f9vtKppa+cxSMq9zwhbL2vj07FOrLzNBL834AaSaTUqZX3noleooms
lMuoaJuvimUnzYnu3Yy1aylwQ6BpC+S5DwIDAQABo0IwQDAdBgNVHQ4EFgQU/qHgcB4qAzlSWkK+
XJGFehiqTbUwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQAD
ggEBAMJKVvoVIXsoounlHfv4LcQ5lkFMOycsxGwYFYDGrK9HWS8mC+M2sO87/kOXSTKZEhVb3xEp
/6tT+LvBeA+snFOvV71ojD1pM/CjoCNjO2RnIkSt1XHLVip4kqNPEjE2NuLe/gDEo2APJ62gsIq1
NnpSob0n9CAnYuhNlCQT5AoE6TyrLshDCUrGYQTlSTR+08TI9Q/Aqum6VF7zYytPT1DU/rl7mYw9
wC68AivTxEDkigcxHpvOJpkT+xHqmiIMERnHXhuBUDDIlhJu58tBf5E7oke3VIAb3ADMmpDqw8NQ
BmIMMMAVSKeoWXzhriKi4gp6D/piq1JM4fHfyr6DDUI=
-----END CERTIFICATE-----

emSign ECC Root CA - C3
=======================
-----BEGIN CERTIFICATE-----
MIICKzCCAbGgAwIBAgIKe3G2gla4EnycqDAKBggqhkjOPQQDAzBaMQswCQYDVQQGEwJVUzETMBEG
A1UECxMKZW1TaWduIFBLSTEUMBIGA1UEChMLZU11ZGhyYSBJbmMxIDAeBgNVBAMTF2VtU2lnbiBF
Q0MgUm9vdCBDQSAtIEMzMB4XDTE4MDIxODE4MzAwMFoXDTQzMDIxODE4MzAwMFowWjELMAkGA1UE
BhMCVVMxEzARBgNVBAsTCmVtU2lnbiBQS0kxFDASBgNVBAoTC2VNdWRocmEgSW5jMSAwHgYDVQQD
ExdlbVNpZ24gRUNDIFJvb3QgQ0EgLSBDMzB2MBAGByqGSM49AgEGBSuBBAAiA2IABP2lYa57JhAd
6bciMK4G9IGzsUJxlTm801Ljr6/58pc1kjZGDoeVjbk5Wum739D+yAdBPLtVb4OjavtisIGJAnB9
SMVK4+kiVCJNk7tCDK93nCOmfddhEc5lx/h//vXyqaNCMEAwHQYDVR0OBBYEFPtaSNCAIEDyqOkA
B2kZd6fmw/TPMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMDA2gA
MGUCMQC02C8Cif22TGK6Q04ThHK1rt0c3ta13FaPWEBaLd4gTCKDypOofu4SQMfWh0/434UCMBwU
ZOR8loMRnLDRWmFLpg9J0wD8ofzkpf9/rdcw0Md3f76BB1UwUCAU9Vc4CqgxUQ==
-----END CERTIFICATE-----

Hongkong Post Root CA 3
=======================
-----BEGIN CERTIFICATE-----
MIIFzzCCA7egAwIBAgIUCBZfikyl7ADJk0DfxMauI7gcWqQwDQYJKoZIhvcNAQELBQAwbzELMAkG
A1UEBhMCSEsxEjAQBgNVBAgTCUhvbmcgS29uZzESMBAGA1UEBxMJSG9uZyBLb25nMRYwFAYDVQQK
Ew1Ib25na29uZyBQb3N0MSAwHgYDVQQDExdIb25na29uZyBQb3N0IFJvb3QgQ0EgMzAeFw0xNzA2
MDMwMjI5NDZaFw00MjA2MDMwMjI5NDZaMG8xCzAJBgNVBAYTAkhLMRIwEAYDVQQIEwlIb25nIEtv
bmcxEjAQBgNVBAcTCUhvbmcgS29uZzEWMBQGA1UEChMNSG9uZ2tvbmcgUG9zdDEgMB4GA1UEAxMX
SG9uZ2tvbmcgUG9zdCBSb290IENBIDMwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCz
iNfqzg8gTr7m1gNt7ln8wlffKWihgw4+aMdoWJwcYEuJQwy51BWy7sFOdem1p+/l6TWZ5Mwc50tf
jTMwIDNT2aa71T4Tjukfh0mtUC1Qyhi+AViiE3CWu4mIVoBc+L0sPOFMV4i707mV78vH9toxdCim
5lSJ9UExyuUmGs2C4HDaOym71QP1mbpV9WTRYA6ziUm4ii8F0oRFKHyPaFASePwLtVPLwpgchKOe
sL4jpNrcyCse2m5FHomY2vkALgbpDDtw1VAliJnLzXNg99X/NWfFobxeq81KuEXryGgeDQ0URhLj
0mRiikKYvLTGCAj4/ahMZJx2Ab0vqWwzD9g/KLg8aQFChn5pwckGyuV6RmXpwtZQQS4/t+TtbNe/
JgERohYpSms0BpDsE9K2+2p20jzt8NYt3eEV7KObLyzJPivkaTv/ciWxNoZbx39ri1UbSsUgYT2u
y1DhCDq+sI9jQVMwCFk8mB13umOResoQUGC/8Ne8lYePl8X+l2oBlKN8W4UdKjk60FSh0Tlxnf0h
+bV78OLgAo9uliQlLKAeLKjEiafv7ZkGL7YKTE/bosw3Gq9HhS2KX8Q0NEwA/RiTZxPRN+ZItIsG
xVd7GYYKecsAyVKvQv83j+GjHno9UKtjBucVtT+2RTeUN7F+8kjDf8V1/peNRY8apxpyKBpADwID
AQABo2MwYTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAfBgNVHSMEGDAWgBQXnc0e
i9Y5K3DTXNSguB+wAPzFYTAdBgNVHQ4EFgQUF53NHovWOStw01zUoLgfsAD8xWEwDQYJKoZIhvcN
AQELBQADggIBAFbVe27mIgHSQpsY1Q7XZiNc4/6gx5LS6ZStS6LG7BJ8dNVI0lkUmcDrudHr9Egw
W62nV3OZqdPlt9EuWSRY3GguLmLYauRwCy0gUCCkMpXRAJi70/33MvJJrsZ64Ee+bs7Lo3I6LWld
y8joRTnU+kLBEUx3XZL7av9YROXrgZ6voJmtvqkBZss4HTzfQx/0TW60uhdG/H39h4F5ag0zD/ov
+BS5gLNdTaqX4fnkGMX41TiMJjz98iji7lpJiCzfeT2OnpA8vUFKOt1b9pq0zj8lMH8yfaIDlNDc
eqFS3m6TjRgm/VWsvY+b0s+v54Ysyx8Jb6NvqYTUc79NoXQbTiNg8swOqn+knEwlqLJmOzj/2ZQw
9nKEvmhVEA/GcywWaZMH/rFF7buiVWqw2rVKAiUnhde3t4ZEFolsgCs+l6mc1X5VTMbeRRAc6uk7
nwNT7u56AQIWeNTowr5GdogTPyK7SBIdUgC0An4hGh6cJfTzPV4e0hz5sy229zdcxsshTrD3mUcY
hcErulWuBurQB7Lcq9CClnXO0lD+mefPL5/ndtFhKvshuzHQqp9HpLIiyhY6UFfEW0NnxWViA0kB
60PZ2Pierc+xYw5F9KBaLJstxabArahH9CdMOA0uG0k7UvToiIMrVCjU8jVStDKDYmlkDJGcn5fq
dBb9HxEGmpv0
-----END CERTIFICATE-----

Microsoft ECC Root Certificate Authority 2017
=============================================
-----BEGIN CERTIFICATE-----
MIICWTCCAd+gAwIBAgIQZvI9r4fei7FK6gxXMQHC7DAKBggqhkjOPQQDAzBlMQswCQYDVQQGEwJV
UzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTYwNAYDVQQDEy1NaWNyb3NvZnQgRUND
IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTcwHhcNMTkxMjE4MjMwNjQ1WhcNNDIwNzE4
MjMxNjA0WjBlMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTYw
NAYDVQQDEy1NaWNyb3NvZnQgRUNDIFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTcwdjAQ
BgcqhkjOPQIBBgUrgQQAIgNiAATUvD0CQnVBEyPNgASGAlEvaqiBYgtlzPbKnR5vSmZRogPZnZH6
thaxjG7efM3beaYvzrvOcS/lpaso7GMEZpn4+vKTEAXhgShC48Zo9OYbhGBKia/teQ87zvH2RPUB
eMCjVDBSMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTIy5lycFIM
+Oa+sgRXKSrPQhDtNTAQBgkrBgEEAYI3FQEEAwIBADAKBggqhkjOPQQDAwNoADBlAjBY8k3qDPlf
Xu5gKcs68tvWMoQZP3zVL8KxzJOuULsJMsbG7X7JNpQS5GiFBqIb0C8CMQCZ6Ra0DvpWSNSkMBaR
eNtUjGUBiudQZsIxtzm6uBoiB078a1QWIP8rtedMDE2mT3M=
-----END CERTIFICATE-----

Microsoft RSA Root Certificate Authority 2017
=============================================
-----BEGIN CERTIFICATE-----
MIIFqDCCA5CgAwIBAgIQHtOXCV/YtLNHcB6qvn9FszANBgkqhkiG9w0BAQwFADBlMQswCQYDVQQG
EwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMTYwNAYDVQQDEy1NaWNyb3NvZnQg
UlNBIFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTcwHhcNMTkxMjE4MjI1MTIyWhcNNDIw
NzE4MjMwMDIzWjBlMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
MTYwNAYDVQQDEy1NaWNyb3NvZnQgUlNBIFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTcw
ggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDKW76UM4wplZEWCpW9R2LBifOZNt9GkMml
7Xhqb0eRaPgnZ1AzHaGm++DlQ6OEAlcBXZxIQIJTELy/xztokLaCLeX0ZdDMbRnMlfl7rEqUrQ7e
S0MdhweSE5CAg2Q1OQT85elss7YfUJQ4ZVBcF0a5toW1HLUX6NZFndiyJrDKxHBKrmCk3bPZ7Pw7
1VdyvD/IybLeS2v4I2wDwAW9lcfNcztmgGTjGqwu+UcF8ga2m3P1eDNbx6H7JyqhtJqRjJHTOoI+
dkC0zVJhUXAoP8XFWvLJjEm7FFtNyP9nTUwSlq31/niol4fX/V4ggNyhSyL71Imtus5Hl0dVe49F
yGcohJUcaDDv70ngNXtk55iwlNpNhTs+VcQor1fznhPbRiefHqJeRIOkpcrVE7NLP8TjwuaGYaRS
MLl6IE9vDzhTyzMMEyuP1pq9KsgtsRx9S1HKR9FIJ3Jdh+vVReZIZZ2vUpC6W6IYZVcSn2i51BVr
lMRpIpj0M+Dt+VGOQVDJNE92kKz8OMHY4Xu54+OU4UZpyw4KUGsTuqwPN1q3ErWQgR5WrlcihtnJ
0tHXUeOrO8ZV/R4O03QK0dqq6mm4lyiPSMQH+FJDOvTKVTUssKZqwJz58oHhEmrARdlns87/I6KJ
ClTUFLkqqNfs+avNJVgyeY+QW5g5xAgGwax/Dj0ApQIDAQABo1QwUjAOBgNVHQ8BAf8EBAMCAYYw
DwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUCctZf4aycI8awznjwNnpv7tNsiMwEAYJKwYBBAGC
NxUBBAMCAQAwDQYJKoZIhvcNAQEMBQADggIBAKyvPl3CEZaJjqPnktaXFbgToqZCLgLNFgVZJ8og
6Lq46BrsTaiXVq5lQ7GPAJtSzVXNUzltYkyLDVt8LkS/gxCP81OCgMNPOsduET/m4xaRhPtthH80
dK2Jp86519efhGSSvpWhrQlTM93uCupKUY5vVau6tZRGrox/2KJQJWVggEbbMwSubLWYdFQl3JPk
+ONVFT24bcMKpBLBaYVu32TxU5nhSnUgnZUP5NbcA/FZGOhHibJXWpS2qdgXKxdJ5XbLwVaZOjex
/2kskZGT4d9Mozd2TaGf+G0eHdP67Pv0RR0Tbc/3WeUiJ3IrhvNXuzDtJE3cfVa7o7P4NHmJweDy
AmH3pvwPuxwXC65B2Xy9J6P9LjrRk5Sxcx0ki69bIImtt2dmefU6xqaWM/5TkshGsRGRxpl/j8nW
ZjEgQRCHLQzWwa80mMpkg/sTV9HB8Dx6jKXB/ZUhoHHBk2dxEuqPiAppGWSZI1b7rCoucL5mxAyE
7+WL85MB+GqQk2dLsmijtWKP6T+MejteD+eMuMZ87zf9dOLITzNy4ZQ5bb0Sr74MTnB8G2+NszKT
c0QWbej09+CVgI+WXTik9KveCjCHk9hNAHFiRSdLOkKEW39lt2c0Ui2cFmuqqNh7o0JMcccMyj6D
5KbvtwEwXlGjefVwaaZBRA+GsCyRxj3qrg+E
-----END CERTIFICATE-----

e-Szigno Root CA 2017
=====================
-----BEGIN CERTIFICATE-----
MIICQDCCAeWgAwIBAgIMAVRI7yH9l1kN9QQKMAoGCCqGSM49BAMCMHExCzAJBgNVBAYTAkhVMREw
DwYDVQQHDAhCdWRhcGVzdDEWMBQGA1UECgwNTWljcm9zZWMgTHRkLjEXMBUGA1UEYQwOVkFUSFUt
MjM1ODQ0OTcxHjAcBgNVBAMMFWUtU3ppZ25vIFJvb3QgQ0EgMjAxNzAeFw0xNzA4MjIxMjA3MDZa
Fw00MjA4MjIxMjA3MDZaMHExCzAJBgNVBAYTAkhVMREwDwYDVQQHDAhCdWRhcGVzdDEWMBQGA1UE
CgwNTWljcm9zZWMgTHRkLjEXMBUGA1UEYQwOVkFUSFUtMjM1ODQ0OTcxHjAcBgNVBAMMFWUtU3pp
Z25vIFJvb3QgQ0EgMjAxNzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJbcPYrYsHtvxie+RJCx
s1YVe45DJH0ahFnuY2iyxl6H0BVIHqiQrb1TotreOpCmYF9oMrWGQd+HWyx7xf58etqjYzBhMA8G
A1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBSHERUI0arBeAyxr87GyZDv
vzAEwDAfBgNVHSMEGDAWgBSHERUI0arBeAyxr87GyZDvvzAEwDAKBggqhkjOPQQDAgNJADBGAiEA
tVfd14pVCzbhhkT61NlojbjcI4qKDdQvfepz7L9NbKgCIQDLpbQS+ue16M9+k/zzNY9vTlp8tLxO
svxyqltZ+efcMQ==
-----END CERTIFICATE-----

certSIGN Root CA G2
===================
-----BEGIN CERTIFICATE-----
MIIFRzCCAy+gAwIBAgIJEQA0tk7GNi02MA0GCSqGSIb3DQEBCwUAMEExCzAJBgNVBAYTAlJPMRQw
EgYDVQQKEwtDRVJUU0lHTiBTQTEcMBoGA1UECxMTY2VydFNJR04gUk9PVCBDQSBHMjAeFw0xNzAy
MDYwOTI3MzVaFw00MjAyMDYwOTI3MzVaMEExCzAJBgNVBAYTAlJPMRQwEgYDVQQKEwtDRVJUU0lH
TiBTQTEcMBoGA1UECxMTY2VydFNJR04gUk9PVCBDQSBHMjCCAiIwDQYJKoZIhvcNAQEBBQADggIP
ADCCAgoCggIBAMDFdRmRfUR0dIf+DjuW3NgBFszuY5HnC2/OOwppGnzC46+CjobXXo9X69MhWf05
N0IwvlDqtg+piNguLWkh59E3GE59kdUWX2tbAMI5Qw02hVK5U2UPHULlj88F0+7cDBrZuIt4Imfk
abBoxTzkbFpG583H+u/E7Eu9aqSs/cwoUe+StCmrqzWaTOTECMYmzPhpn+Sc8CnTXPnGFiWeI8Mg
wT0PPzhAsP6CRDiqWhqKa2NYOLQV07YRaXseVO6MGiKscpc/I1mbySKEwQdPzH/iV8oScLumZfNp
dWO9lfsbl83kqK/20U6o2YpxJM02PbyWxPFsqa7lzw1uKA2wDrXKUXt4FMMgL3/7FFXhEZn91Qqh
ngLjYl/rNUssuHLoPj1PrCy7Lobio3aP5ZMqz6WryFyNSwb/EkaseMsUBzXgqd+L6a8VTxaJW732
jcZZroiFDsGJ6x9nxUWO/203Nit4ZoORUSs9/1F3dmKh7Gc+PoGD4FapUB8fepmrY7+EF3fxDTvf
95xhszWYijqy7DwaNz9+j5LP2RIUZNoQAhVB/0/E6xyjyfqZ90bp4RjZsbgyLcsUDFDYg2WD7rlc
z8sFWkz6GZdr1l0T08JcVLwyc6B49fFtHsufpaafItzRUZ6CeWRgKRM+o/1Pcmqr4tTluCRVLERL
iohEnMqE0yo7AgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1Ud
DgQWBBSCIS1mxteg4BXrzkwJd8RgnlRuAzANBgkqhkiG9w0BAQsFAAOCAgEAYN4auOfyYILVAzOB
ywaK8SJJ6ejqkX/GM15oGQOGO0MBzwdw5AgeZYWR5hEit/UCI46uuR59H35s5r0l1ZUa8gWmr4UC
b6741jH/JclKyMeKqdmfS0mbEVeZkkMR3rYzpMzXjWR91M08KCy0mpbqTfXERMQlqiCA2ClV9+BB
/AYm/7k29UMUA2Z44RGx2iBfRgB4ACGlHgAoYXhvqAEBj500mv/0OJD7uNGzcgbJceaBxXntC6Z5
8hMLnPddDnskk7RI24Zf3lCGeOdA5jGokHZwYa+cNywRtYK3qq4kNFtyDGkNzVmf9nGvnAvRCjj5
BiKDUyUM/FHE5r7iOZULJK2v0ZXkltd0ZGtxTgI8qoXzIKNDOXZbbFD+mpwUHmUUihW9o4JFWklW
atKcsWMy5WHgUyIOpwpJ6st+H6jiYoD2EEVSmAYY3qXNL3+q1Ok+CHLsIwMCPKaq2LxndD0UF/tU
Sxfj03k9bWtJySgOLnRQvwzZRjoQhsmnP+mg7H/rpXdYaXHmgwo38oZJar55CJD2AhZkPuXaTH4M
NMn5X7azKFGnpyuqSfqNZSlO42sTp5SjLVFteAxEy9/eCG/Oo2Sr05WE1LlSVHJ7liXMvGnjSG4N
0MedJ5qq+BOS3R7fY581qRY27Iy4g/Q9iY/NtBde17MXQRBdJ3NghVdJIgc=
-----END CERTIFICATE-----

NAVER Global Root Certification Authority
=========================================
-----BEGIN CERTIFICATE-----
MIIFojCCA4qgAwIBAgIUAZQwHqIL3fXFMyqxQ0Rx+NZQTQ0wDQYJKoZIhvcNAQEMBQAwaTELMAkG
A1UEBhMCS1IxJjAkBgNVBAoMHU5BVkVSIEJVU0lORVNTIFBMQVRGT1JNIENvcnAuMTIwMAYDVQQD
DClOQVZFUiBHbG9iYWwgUm9vdCBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTAeFw0xNzA4MTgwODU4
NDJaFw0zNzA4MTgyMzU5NTlaMGkxCzAJBgNVBAYTAktSMSYwJAYDVQQKDB1OQVZFUiBCVVNJTkVT
UyBQTEFURk9STSBDb3JwLjEyMDAGA1UEAwwpTkFWRVIgR2xvYmFsIFJvb3QgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC21PGTXLVAiQqrDZBb
UGOukJR0F0Vy1ntlWilLp1agS7gvQnXp2XskWjFlqxcX0TM62RHcQDaH38dq6SZeWYp34+hInDEW
+j6RscrJo+KfziFTowI2MMtSAuXaMl3Dxeb57hHHi8lEHoSTGEq0n+USZGnQJoViAbbJAh2+g1G7
XNr4rRVqmfeSVPc0W+m/6imBEtRTkZazkVrd/pBzKPswRrXKCAfHcXLJZtM0l/aM9BhK4dA9WkW2
aacp+yPOiNgSnABIqKYPszuSjXEOdMWLyEz59JuOuDxp7W87UC9Y7cSw0BwbagzivESq2M0UXZR4
Yb8ObtoqvC8MC3GmsxY/nOb5zJ9TNeIDoKAYv7vxvvTWjIcNQvcGufFt7QSUqP620wbGQGHfnZ3z
VHbOUzoBppJB7ASjjw2i1QnK1sua8e9DXcCrpUHPXFNwcMmIpi3Ua2FzUCaGYQ5fG8Ir4ozVu53B
A0K6lNpfqbDKzE0K70dpAy8i+/Eozr9dUGWokG2zdLAIx6yo0es+nPxdGoMuK8u180SdOqcXYZai
cdNwlhVNt0xz7hlcxVs+Qf6sdWA7G2POAN3aCJBitOUt7kinaxeZVL6HSuOpXgRM6xBtVNbv8ejy
YhbLgGvtPe31HzClrkvJE+2KAQHJuFFYwGY6sWZLxNUxAmLpdIQM201GLQIDAQABo0IwQDAdBgNV
HQ4EFgQU0p+I36HNLL3s9TsBAZMzJ7LrYEswDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMB
Af8wDQYJKoZIhvcNAQEMBQADggIBADLKgLOdPVQG3dLSLvCkASELZ0jKbY7gyKoNqo0hV4/GPnrK
21HUUrPUloSlWGB/5QuOH/XcChWB5Tu2tyIvCZwTFrFsDDUIbatjcu3cvuzHV+YwIHHW1xDBE1UB
jCpD5EHxzzp6U5LOogMFDTjfArsQLtk70pt6wKGm+LUx5vR1yblTmXVHIloUFcd4G7ad6Qz4G3bx
hYTeodoS76TiEJd6eN4MUZeoIUCLhr0N8F5OSza7OyAfikJW4Qsav3vQIkMsRIz75Sq0bBwcupTg
E34h5prCy8VCZLQelHsIJchxzIdFV4XTnyliIoNRlwAYl3dqmJLJfGBs32x9SuRwTMKeuB330DTH
D8z7p/8Dvq1wkNoL3chtl1+afwkyQf3NosxabUzyqkn+Zvjp2DXrDige7kgvOtB5CTh8piKCk5XQ
A76+AqAF3SAi428diDRgxuYKuQl1C/AH6GmWNcf7I4GOODm4RStDeKLRLBT/DShycpWbXgnbiUSY
qqFJu3FS8r/2/yehNq+4tneI3TqkbZs0kNwUXTC/t+sX5Ie3cdCh13cV1ELX8vMxmV2b3RZtP+oG
I/hGoiLtk/bdmuYqh7GYVPEi92tF4+KOdh2ajcQGjTa3FPOdVGm3jjzVpG2Tgbet9r1ke8LJaDmg
kpzNNIaRkPpkUZ3+/uul9XXeifdy
-----END CERTIFICATE-----

AC RAIZ FNMT-RCM SERVIDORES SEGUROS
===================================
-----BEGIN CERTIFICATE-----
MIICbjCCAfOgAwIBAgIQYvYybOXE42hcG2LdnC6dlTAKBggqhkjOPQQDAzB4MQswCQYDVQQGEwJF
UzERMA8GA1UECgwIRk5NVC1SQ00xDjAMBgNVBAsMBUNlcmVzMRgwFgYDVQRhDA9WQVRFUy1RMjgy
NjAwNEoxLDAqBgNVBAMMI0FDIFJBSVogRk5NVC1SQ00gU0VSVklET1JFUyBTRUdVUk9TMB4XDTE4
MTIyMDA5MzczM1oXDTQzMTIyMDA5MzczM1oweDELMAkGA1UEBhMCRVMxETAPBgNVBAoMCEZOTVQt
UkNNMQ4wDAYDVQQLDAVDZXJlczEYMBYGA1UEYQwPVkFURVMtUTI4MjYwMDRKMSwwKgYDVQQDDCNB
QyBSQUlaIEZOTVQtUkNNIFNFUlZJRE9SRVMgU0VHVVJPUzB2MBAGByqGSM49AgEGBSuBBAAiA2IA
BPa6V1PIyqvfNkpSIeSX0oNnnvBlUdBeh8dHsVnyV0ebAAKTRBdp20LHsbI6GA60XYyzZl2hNPk2
LEnb80b8s0RpRBNm/dfF/a82Tc4DTQdxz69qBdKiQ1oKUm8BA06Oi6NCMEAwDwYDVR0TAQH/BAUw
AwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFAG5L++/EYZg8k/QQW6rcx/n0m5JMAoGCCqG
SM49BAMDA2kAMGYCMQCuSuMrQMN0EfKVrRYj3k4MGuZdpSRea0R7/DjiT8ucRRcRTBQnJlU5dUoD
zBOQn5ICMQD6SmxgiHPz7riYYqnOK8LZiqZwMR2vsJRM60/G49HzYqc8/5MuB1xJAWdpEgJyv+c=
-----END CERTIFICATE-----

GlobalSign Root R46
===================
-----BEGIN CERTIFICATE-----
MIIFWjCCA0KgAwIBAgISEdK7udcjGJ5AXwqdLdDfJWfRMA0GCSqGSIb3DQEBDAUAMEYxCzAJBgNV
BAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52LXNhMRwwGgYDVQQDExNHbG9iYWxTaWduIFJv
b3QgUjQ2MB4XDTE5MDMyMDAwMDAwMFoXDTQ2MDMyMDAwMDAwMFowRjELMAkGA1UEBhMCQkUxGTAX
BgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExHDAaBgNVBAMTE0dsb2JhbFNpZ24gUm9vdCBSNDYwggIi
MA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCsrHQy6LNl5brtQyYdpokNRbopiLKkHWPd08Es
CVeJOaFV6Wc0dwxu5FUdUiXSE2te4R2pt32JMl8Nnp8semNgQB+msLZ4j5lUlghYruQGvGIFAha/
r6gjA7aUD7xubMLL1aa7DOn2wQL7Id5m3RerdELv8HQvJfTqa1VbkNud316HCkD7rRlr+/fKYIje
2sGP1q7Vf9Q8g+7XFkyDRTNrJ9CG0Bwta/OrffGFqfUo0q3v84RLHIf8E6M6cqJaESvWJ3En7YEt
bWaBkoe0G1h6zD8K+kZPTXhc+CtI4wSEy132tGqzZfxCnlEmIyDLPRT5ge1lFgBPGmSXZgjPjHvj
K8Cd+RTyG/FWaha/LIWFzXg4mutCagI0GIMXTpRW+LaCtfOW3T3zvn8gdz57GSNrLNRyc0NXfeD4
12lPFzYE+cCQYDdF3uYM2HSNrpyibXRdQr4G9dlkbgIQrImwTDsHTUB+JMWKmIJ5jqSngiCNI/on
ccnfxkF0oE32kRbcRoxfKWMxWXEM2G/CtjJ9++ZdU6Z+Ffy7dXxd7Pj2Fxzsx2sZy/N78CsHpdls
eVR2bJ0cpm4O6XkMqCNqo98bMDGfsVR7/mrLZqrcZdCinkqaByFrgY/bxFn63iLABJzjqls2k+g9
vXqhnQt2sQvHnf3PmKgGwvgqo6GDoLclcqUC4wIDAQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYD
VR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUA1yrc4GHqMywptWU4jaWSf8FmSwwDQYJKoZIhvcNAQEM
BQADggIBAHx47PYCLLtbfpIrXTncvtgdokIzTfnvpCo7RGkerNlFo048p9gkUbJUHJNOxO97k4Vg
JuoJSOD1u8fpaNK7ajFxzHmuEajwmf3lH7wvqMxX63bEIaZHU1VNaL8FpO7XJqti2kM3S+LGteWy
gxk6x9PbTZ4IevPuzz5i+6zoYMzRx6Fcg0XERczzF2sUyQQCPtIkpnnpHs6i58FZFZ8d4kuaPp92
CC1r2LpXFNqD6v6MVenQTqnMdzGxRBF6XLE+0xRFFRhiJBPSy03OXIPBNvIQtQ6IbbjhVp+J3pZm
OUdkLG5NrmJ7v2B0GbhWrJKsFjLtrWhV/pi60zTe9Mlhww6G9kuEYO4Ne7UyWHmRVSyBQ7N0H3qq
JZ4d16GLuc1CLgSkZoNNiTW2bKg2SnkheCLQQrzRQDGQob4Ez8pn7fXwgNNgyYMqIgXQBztSvwye
qiv5u+YfjyW6hY0XHgL+XVAEV8/+LbzvXMAaq7afJMbfc2hIkCwU9D9SGuTSyxTDYWnP4vkYxboz
nxSjBF25cfe1lNj2M8FawTSLfJvdkzrnE6JwYZ+vj+vYxXX4M2bUdGc6N3ec592kD3ZDZopD8p/7
DEJ4Y9HiD2971KE9dJeFt0g5QdYg/NA6s/rob8SKunE3vouXsXgxT7PntgMTzlSdriVZzH81Xwj3
QEUxeCp6
-----END CERTIFICATE-----

GlobalSign Root E46
===================
-----BEGIN CERTIFICATE-----
MIICCzCCAZGgAwIBAgISEdK7ujNu1LzmJGjFDYQdmOhDMAoGCCqGSM49BAMDMEYxCzAJBgNVBAYT
AkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52LXNhMRwwGgYDVQQDExNHbG9iYWxTaWduIFJvb3Qg
RTQ2MB4XDTE5MDMyMDAwMDAwMFoXDTQ2MDMyMDAwMDAwMFowRjELMAkGA1UEBhMCQkUxGTAXBgNV
BAoTEEdsb2JhbFNpZ24gbnYtc2ExHDAaBgNVBAMTE0dsb2JhbFNpZ24gUm9vdCBFNDYwdjAQBgcq
hkjOPQIBBgUrgQQAIgNiAAScDrHPt+ieUnd1NPqlRqetMhkytAepJ8qUuwzSChDH2omwlwxwEwkB
jtjqR+q+soArzfwoDdusvKSGN+1wCAB16pMLey5SnCNoIwZD7JIvU4Tb+0cUB+hflGddyXqBPCCj
QjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBQxCpCPtsad0kRL
gLWi5h+xEk8blTAKBggqhkjOPQQDAwNoADBlAjEA31SQ7Zvvi5QCkxeCmb6zniz2C5GMn0oUsfZk
vLtoURMMA/cVi4RguYv/Uo7njLwcAjA8+RHUjE7AwWHCFUyqqx0LMV87HOIAl0Qx5v5zli/altP+
CAezNIm8BZ/3Hobui3A=
-----END CERTIFICATE-----

ANF Secure Server Root CA
=========================
-----BEGIN CERTIFICATE-----
MIIF7zCCA9egAwIBAgIIDdPjvGz5a7EwDQYJKoZIhvcNAQELBQAwgYQxEjAQBgNVBAUTCUc2MzI4
NzUxMDELMAkGA1UEBhMCRVMxJzAlBgNVBAoTHkFORiBBdXRvcmlkYWQgZGUgQ2VydGlmaWNhY2lv
bjEUMBIGA1UECxMLQU5GIENBIFJhaXoxIjAgBgNVBAMTGUFORiBTZWN1cmUgU2VydmVyIFJvb3Qg
Q0EwHhcNMTkwOTA0MTAwMDM4WhcNMzkwODMwMTAwMDM4WjCBhDESMBAGA1UEBRMJRzYzMjg3NTEw
MQswCQYDVQQGEwJFUzEnMCUGA1UEChMeQU5GIEF1dG9yaWRhZCBkZSBDZXJ0aWZpY2FjaW9uMRQw
EgYDVQQLEwtBTkYgQ0EgUmFpejEiMCAGA1UEAxMZQU5GIFNlY3VyZSBTZXJ2ZXIgUm9vdCBDQTCC
AiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANvrayvmZFSVgpCjcqQZAZ2cC4Ffc0m6p6zz
BE57lgvsEeBbphzOG9INgxwruJ4dfkUyYA8H6XdYfp9qyGFOtibBTI3/TO80sh9l2Ll49a2pcbnv
T1gdpd50IJeh7WhM3pIXS7yr/2WanvtH2Vdy8wmhrnZEE26cLUQ5vPnHO6RYPUG9tMJJo8gN0pcv
B2VSAKduyK9o7PQUlrZXH1bDOZ8rbeTzPvY1ZNoMHKGESy9LS+IsJJ1tk0DrtSOOMspvRdOoiXse
zx76W0OLzc2oD2rKDF65nkeP8Nm2CgtYZRczuSPkdxl9y0oukntPLxB3sY0vaJxizOBQ+OyRp1RM
VwnVdmPF6GUe7m1qzwmd+nxPrWAI/VaZDxUse6mAq4xhj0oHdkLePfTdsiQzW7i1o0TJrH93PB0j
7IKppuLIBkwC/qxcmZkLLxCKpvR/1Yd0DVlJRfbwcVw5Kda/SiOL9V8BY9KHcyi1Swr1+KuCLH5z
JTIdC2MKF4EA/7Z2Xue0sUDKIbvVgFHlSFJnLNJhiQcND85Cd8BEc5xEUKDbEAotlRyBr+Qc5RQe
8TZBAQIvfXOn3kLMTOmJDVb3n5HUA8ZsyY/b2BzgQJhdZpmYgG4t/wHFzstGH6wCxkPmrqKEPMVO
Hj1tyRRM4y5Bu8o5vzY8KhmqQYdOpc5LMnndkEl/AgMBAAGjYzBhMB8GA1UdIwQYMBaAFJxf0Gxj
o1+TypOYCK2Mh6UsXME3MB0GA1UdDgQWBBScX9BsY6Nfk8qTmAitjIelLFzBNzAOBgNVHQ8BAf8E
BAMCAYYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAgEATh65isagmD9uw2nAalxJ
UqzLK114OMHVVISfk/CHGT0sZonrDUL8zPB1hT+L9IBdeeUXZ701guLyPI59WzbLWoAAKfLOKyzx
j6ptBZNscsdW699QIyjlRRA96Gejrw5VD5AJYu9LWaL2U/HANeQvwSS9eS9OICI7/RogsKQOLHDt
dD+4E5UGUcjohybKpFtqFiGS3XNgnhAY3jyB6ugYw3yJ8otQPr0R4hUDqDZ9MwFsSBXXiJCZBMXM
5gf0vPSQ7RPi6ovDj6MzD8EpTBNO2hVWcXNyglD2mjN8orGoGjR0ZVzO0eurU+AagNjqOknkJjCb
5RyKqKkVMoaZkgoQI1YS4PbOTOK7vtuNknMBZi9iPrJyJ0U27U1W45eZ/zo1PqVUSlJZS2Db7v54
EX9K3BR5YLZrZAPbFYPhor72I5dQ8AkzNqdxliXzuUJ92zg/LFis6ELhDtjTO0wugumDLmsx2d1H
hk9tl5EuT+IocTUW0fJz/iUrB0ckYyfI+PbZa/wSMVYIwFNCr5zQM378BvAxRAMU8Vjq8moNqRGy
g77FGr8H6lnco4g175x2MjxNBiLOFeXdntiP2t7SxDnlF4HPOEfrf4htWRvfn0IUrn7PqLBmZdo3
r5+qPeoott7VMVgWglvquxl1AnMaykgaIZOQCo6ThKd9OyMYkomgjaw=
-----END CERTIFICATE-----

Certum EC-384 CA
================
-----BEGIN CERTIFICATE-----
MIICZTCCAeugAwIBAgIQeI8nXIESUiClBNAt3bpz9DAKBggqhkjOPQQDAzB0MQswCQYDVQQGEwJQ
TDEhMB8GA1UEChMYQXNzZWNvIERhdGEgU3lzdGVtcyBTLkEuMScwJQYDVQQLEx5DZXJ0dW0gQ2Vy
dGlmaWNhdGlvbiBBdXRob3JpdHkxGTAXBgNVBAMTEENlcnR1bSBFQy0zODQgQ0EwHhcNMTgwMzI2
MDcyNDU0WhcNNDMwMzI2MDcyNDU0WjB0MQswCQYDVQQGEwJQTDEhMB8GA1UEChMYQXNzZWNvIERh
dGEgU3lzdGVtcyBTLkEuMScwJQYDVQQLEx5DZXJ0dW0gQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkx
GTAXBgNVBAMTEENlcnR1bSBFQy0zODQgQ0EwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAATEKI6rGFtq
vm5kN2PkzeyrOvfMobgOgknXhimfoZTy42B4mIF4Bk3y7JoOV2CDn7TmFy8as10CW4kjPMIRBSqn
iBMY81CE1700LCeJVf/OTOffph8oxPBUw7l8t1Ot68KjQjBAMA8GA1UdEwEB/wQFMAMBAf8wHQYD
VR0OBBYEFI0GZnQkdjrzife81r1HfS+8EF9LMA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAwNo
ADBlAjADVS2m5hjEfO/JUG7BJw+ch69u1RsIGL2SKcHvlJF40jocVYli5RsJHrpka/F2tNQCMQC0
QoSZ/6vnnvuRlydd3LBbMHHOXjgaatkl5+r3YZJW+OraNsKHZZYuciUvf9/DE8k=
-----END CERTIFICATE-----

Certum Trusted Root CA
======================
-----BEGIN CERTIFICATE-----
MIIFwDCCA6igAwIBAgIQHr9ZULjJgDdMBvfrVU+17TANBgkqhkiG9w0BAQ0FADB6MQswCQYDVQQG
EwJQTDEhMB8GA1UEChMYQXNzZWNvIERhdGEgU3lzdGVtcyBTLkEuMScwJQYDVQQLEx5DZXJ0dW0g
Q2VydGlmaWNhdGlvbiBBdXRob3JpdHkxHzAdBgNVBAMTFkNlcnR1bSBUcnVzdGVkIFJvb3QgQ0Ew
HhcNMTgwMzE2MTIxMDEzWhcNNDMwMzE2MTIxMDEzWjB6MQswCQYDVQQGEwJQTDEhMB8GA1UEChMY
QXNzZWNvIERhdGEgU3lzdGVtcyBTLkEuMScwJQYDVQQLEx5DZXJ0dW0gQ2VydGlmaWNhdGlvbiBB
dXRob3JpdHkxHzAdBgNVBAMTFkNlcnR1bSBUcnVzdGVkIFJvb3QgQ0EwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQDRLY67tzbqbTeRn06TpwXkKQMlzhyC93yZn0EGze2jusDbCSzBfN8p
fktlL5On1AFrAygYo9idBcEq2EXxkd7fO9CAAozPOA/qp1x4EaTByIVcJdPTsuclzxFUl6s1wB52
HO8AU5853BSlLCIls3Jy/I2z5T4IHhQqNwuIPMqw9MjCoa68wb4pZ1Xi/K1ZXP69VyywkI3C7Te2
fJmItdUDmj0VDT06qKhF8JVOJVkdzZhpu9PMMsmN74H+rX2Ju7pgE8pllWeg8xn2A1bUatMn4qGt
g/BKEiJ3HAVz4hlxQsDsdUaakFjgao4rpUYwBI4Zshfjvqm6f1bxJAPXsiEodg42MEx51UGamqi4
NboMOvJEGyCI98Ul1z3G4z5D3Yf+xOr1Uz5MZf87Sst4WmsXXw3Hw09Omiqi7VdNIuJGmj8PkTQk
fVXjjJU30xrwCSss0smNtA0Aq2cpKNgB9RkEth2+dv5yXMSFytKAQd8FqKPVhJBPC/PgP5sZ0jeJ
P/J7UhyM9uH3PAeXjA6iWYEMspA90+NZRu0PqafegGtaqge2Gcu8V/OXIXoMsSt0Puvap2ctTMSY
njYJdmZm/Bo/6khUHL4wvYBQv3y1zgD2DGHZ5yQD4OMBgQ692IU0iL2yNqh7XAjlRICMb/gv1SHK
HRzQ+8S1h9E6Tsd2tTVItQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSM+xx1
vALTn04uSNn5YFSqxLNP+jAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQENBQADggIBAEii1QAL
LtA/vBzVtVRJHlpr9OTy4EA34MwUe7nJ+jW1dReTagVphZzNTxl4WxmB82M+w85bj/UvXgF2Ez8s
ALnNllI5SW0ETsXpD4YN4fqzX4IS8TrOZgYkNCvozMrnadyHncI013nR03e4qllY/p0m+jiGPp2K
h2RX5Rc64vmNueMzeMGQ2Ljdt4NR5MTMI9UGfOZR0800McD2RrsLrfw9EAUqO0qRJe6M1ISHgCq8
CYyqOhNf6DR5UMEQGfnTKB7U0VEwKbOukGfWHwpjscWpxkIxYxeU72nLL/qMFH3EQxiJ2fAyQOaA
4kZf5ePBAFmo+eggvIksDkc0C+pXwlM2/KfUrzHN/gLldfq5Jwn58/U7yn2fqSLLiMmq0Uc9Nneo
WWRrJ8/vJ8HjJLWG965+Mk2weWjROeiQWMODvA8s1pfrzgzhIMfatz7DP78v3DSk+yshzWePS/Tj
6tQ/50+6uaWTRRxmHyH6ZF5v4HaUMst19W7l9o/HuKTMqJZ9ZPskWkoDbGs4xugDQ5r3V7mzKWmT
OPQD8rv7gmsHINFSH5pkAnuYZttcTVoP0ISVoDwUQwbKytu4QTbaakRnh6+v40URFWkIsr4WOZck
bxJF0WddCajJFdr60qZfE2Efv4WstK2tBZQIgx51F9NxO5NQI1mg7TyRVJ12AMXDuDjb
-----END CERTIFICATE-----

TunTrust Root CA
================
-----BEGIN CERTIFICATE-----
MIIFszCCA5ugAwIBAgIUEwLV4kBMkkaGFmddtLu7sms+/BMwDQYJKoZIhvcNAQELBQAwYTELMAkG
A1UEBhMCVE4xNzA1BgNVBAoMLkFnZW5jZSBOYXRpb25hbGUgZGUgQ2VydGlmaWNhdGlvbiBFbGVj
dHJvbmlxdWUxGTAXBgNVBAMMEFR1blRydXN0IFJvb3QgQ0EwHhcNMTkwNDI2MDg1NzU2WhcNNDQw
NDI2MDg1NzU2WjBhMQswCQYDVQQGEwJUTjE3MDUGA1UECgwuQWdlbmNlIE5hdGlvbmFsZSBkZSBD
ZXJ0aWZpY2F0aW9uIEVsZWN0cm9uaXF1ZTEZMBcGA1UEAwwQVHVuVHJ1c3QgUm9vdCBDQTCCAiIw
DQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMPN0/y9BFPdDCA61YguBUtB9YOCfvdZn56eY+hz
2vYGqU8ftPkLHzmMmiDQfgbU7DTZhrx1W4eI8NLZ1KMKsmwb60ksPqxd2JQDoOw05TDENX37Jk0b
bjBU2PWARZw5rZzJJQRNmpA+TkBuimvNKWfGzC3gdOgFVwpIUPp6Q9p+7FuaDmJ2/uqdHYVy7BG7
NegfJ7/Boce7SBbdVtfMTqDhuazb1YMZGoXRlJfXyqNlC/M4+QKu3fZnz8k/9YosRxqZbwUN/dAd
gjH8KcwAWJeRTIAAHDOFli/LQcKLEITDCSSJH7UP2dl3RxiSlGBcx5kDPP73lad9UKGAwqmDrViW
VSHbhlnUr8a83YFuB9tgYv7sEG7aaAH0gxupPqJbI9dkxt/con3YS7qC0lH4Zr8GRuR5KiY2eY8f
Tpkdso8MDhz/yV3A/ZAQprE38806JG60hZC/gLkMjNWb1sjxVj8agIl6qeIbMlEsPvLfe/ZdeikZ
juXIvTZxi11Mwh0/rViizz1wTaZQmCXcI/m4WEEIcb9PuISgjwBUFfyRbVinljvrS5YnzWuioYas
DXxU5mZMZl+QviGaAkYt5IPCgLnPSz7ofzwB7I9ezX/SKEIBlYrilz0QIX32nRzFNKHsLA4KUiwS
VXAkPcvCFDVDXSdOvsC9qnyW5/yeYa1E0wCXAgMBAAGjYzBhMB0GA1UdDgQWBBQGmpsfU33x9aTI
04Y+oXNZtPdEITAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFAaamx9TffH1pMjThj6hc1m0
90QhMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAgEAqgVutt0Vyb+zxiD2BkewhpMl
0425yAA/l/VSJ4hxyXT968pk21vvHl26v9Hr7lxpuhbI87mP0zYuQEkHDVneixCwSQXi/5E/S7fd
Ao74gShczNxtr18UnH1YeA32gAm56Q6XKRm4t+v4FstVEuTGfbvE7Pi1HE4+Z7/FXxttbUcoqgRY
YdZ2vyJ/0Adqp2RT8JeNnYA/u8EH22Wv5psymsNUk8QcCMNE+3tjEUPRahphanltkE8pjkcFwRJp
adbGNjHh/PqAulxPxOu3Mqz4dWEX1xAZufHSCe96Qp1bWgvUxpVOKs7/B9dPfhgGiPEZtdmYu65x
xBzndFlY7wyJz4sfdZMaBBSSSFCp61cpABbjNhzI+L/wM9VBD8TMPN3pM0MBkRArHtG5Xc0yGYuP
jCB31yLEQtyEFpslbei0VXF/sHyz03FJuc9SpAQ/3D2gu68zngowYI7bnV2UqL1g52KAdoGDDIzM
MEZJ4gzSqK/rYXHv5yJiqfdcZGyfFoxnNidF9Ql7v/YQCvGwjVRDjAS6oz/v4jXH+XTgbzRB0L9z
ZVcg+ZtnemZoJE6AZb0QmQZZ8mWvuMZHu/2QeItBcy6vVR/cO5JyboTT0GFMDcx2V+IthSIVNg3r
AZ3r2OvEhJn7wAzMMujjd9qDRIueVSjAi1jTkD5OGwDxFa2DK5o=
-----END CERTIFICATE-----

HARICA TLS RSA Root CA 2021
===========================
-----BEGIN CERTIFICATE-----
MIIFpDCCA4ygAwIBAgIQOcqTHO9D88aOk8f0ZIk4fjANBgkqhkiG9w0BAQsFADBsMQswCQYDVQQG
EwJHUjE3MDUGA1UECgwuSGVsbGVuaWMgQWNhZGVtaWMgYW5kIFJlc2VhcmNoIEluc3RpdHV0aW9u
cyBDQTEkMCIGA1UEAwwbSEFSSUNBIFRMUyBSU0EgUm9vdCBDQSAyMDIxMB4XDTIxMDIxOTEwNTUz
OFoXDTQ1MDIxMzEwNTUzN1owbDELMAkGA1UEBhMCR1IxNzA1BgNVBAoMLkhlbGxlbmljIEFjYWRl
bWljIGFuZCBSZXNlYXJjaCBJbnN0aXR1dGlvbnMgQ0ExJDAiBgNVBAMMG0hBUklDQSBUTFMgUlNB
IFJvb3QgQ0EgMjAyMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAIvC569lmwVnlskN
JLnQDmT8zuIkGCyEf3dRywQRNrhe7Wlxp57kJQmXZ8FHws+RFjZiPTgE4VGC/6zStGndLuwRo0Xu
a2s7TL+MjaQenRG56Tj5eg4MmOIjHdFOY9TnuEFE+2uva9of08WRiFukiZLRgeaMOVig1mlDqa2Y
Ulhu2wr7a89o+uOkXjpFc5gH6l8Cct4MpbOfrqkdtx2z/IpZ525yZa31MJQjB/OCFks1mJxTuy/K
5FrZx40d/JiZ+yykgmvwKh+OC19xXFyuQnspiYHLA6OZyoieC0AJQTPb5lh6/a6ZcMBaD9YThnEv
dmn8kN3bLW7R8pv1GmuebxWMevBLKKAiOIAkbDakO/IwkfN4E8/BPzWr8R0RI7VDIp4BkrcYAuUR
0YLbFQDMYTfBKnya4dC6s1BG7oKsnTH4+yPiAwBIcKMJJnkVU2DzOFytOOqBAGMUuTNe3QvboEUH
GjMJ+E20pwKmafTCWQWIZYVWrkvL4N48fS0ayOn7H6NhStYqE613TBoYm5EPWNgGVMWX+Ko/IIqm
haZ39qb8HOLubpQzKoNQhArlT4b4UEV4AIHrW2jjJo3Me1xR9BQsQL4aYB16cmEdH2MtiKrOokWQ
CPxrvrNQKlr9qEgYRtaQQJKQCoReaDH46+0N0x3GfZkYVVYnZS6NRcUk7M7jAgMBAAGjQjBAMA8G
A1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFApII6ZgpJIKM+qTW8VX6iVNvRLuMA4GA1UdDwEB/wQE
AwIBhjANBgkqhkiG9w0BAQsFAAOCAgEAPpBIqm5iFSVmewzVjIuJndftTgfvnNAUX15QvWiWkKQU
EapobQk1OUAJ2vQJLDSle1mESSmXdMgHHkdt8s4cUCbjnj1AUz/3f5Z2EMVGpdAgS1D0NTsY9FVq
QRtHBmg8uwkIYtlfVUKqrFOFrJVWNlar5AWMxajaH6NpvVMPxP/cyuN+8kyIhkdGGvMA9YCRotxD
QpSbIPDRzbLrLFPCU3hKTwSUQZqPJzLB5UkZv/HywouoCjkxKLR9YjYsTewfM7Z+d21+UPCfDtcR
j88YxeMn/ibvBZ3PzzfF0HvaO7AWhAw6k9a+F9sPPg4ZeAnHqQJyIkv3N3a6dcSFA1pj1bF1BcK5
vZStjBWZp5N99sXzqnTPBIWUmAD04vnKJGW/4GKvyMX6ssmeVkjaef2WdhW+o45WxLM0/L5H9MG0
qPzVMIho7suuyWPEdr6sOBjhXlzPrjoiUevRi7PzKzMHVIf6tLITe7pTBGIBnfHAT+7hOtSLIBD6
Alfm78ELt5BGnBkpjNxvoEppaZS3JGWg/6w/zgH7IS79aPib8qXPMThcFarmlwDB31qlpzmq6YR/
PFGoOtmUW4y/Twhx5duoXNTSpv4Ao8YWxw/ogM4cKGR0GQjTQuPOAF1/sdwTsOEFy9EgqoZ0njnn
kf3/W9b3raYvAwtt41dU63ZTGI0RmLo=
-----END CERTIFICATE-----

HARICA TLS ECC Root CA 2021
===========================
-----BEGIN CERTIFICATE-----
MIICVDCCAdugAwIBAgIQZ3SdjXfYO2rbIvT/WeK/zjAKBggqhkjOPQQDAzBsMQswCQYDVQQGEwJH
UjE3MDUGA1UECgwuSGVsbGVuaWMgQWNhZGVtaWMgYW5kIFJlc2VhcmNoIEluc3RpdHV0aW9ucyBD
QTEkMCIGA1UEAwwbSEFSSUNBIFRMUyBFQ0MgUm9vdCBDQSAyMDIxMB4XDTIxMDIxOTExMDExMFoX
DTQ1MDIxMzExMDEwOVowbDELMAkGA1UEBhMCR1IxNzA1BgNVBAoMLkhlbGxlbmljIEFjYWRlbWlj
IGFuZCBSZXNlYXJjaCBJbnN0aXR1dGlvbnMgQ0ExJDAiBgNVBAMMG0hBUklDQSBUTFMgRUNDIFJv
b3QgQ0EgMjAyMTB2MBAGByqGSM49AgEGBSuBBAAiA2IABDgI/rGgltJ6rK9JOtDA4MM7KKrxcm1l
AEeIhPyaJmuqS7psBAqIXhfyVYf8MLA04jRYVxqEU+kw2anylnTDUR9YSTHMmE5gEYd103KUkE+b
ECUqqHgtvpBBWJAVcqeht6NCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUyRtTgRL+BNUW
0aq8mm+3oJUZbsowDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2cAMGQCMBHervjcToiwqfAi
rcJRQO9gcS3ujwLEXQNwSaSS6sUUiHCm0w2wqsosQJz76YJumgIwK0eaB8bRwoF8yguWGEEbo/Qw
CZ61IygNnxS2PFOiTAZpffpskcYqSUXm7LcT4Tps
-----END CERTIFICATE-----

Autoridad de Certificacion Firmaprofesional CIF A62634068
=========================================================
-----BEGIN CERTIFICATE-----
MIIGFDCCA/ygAwIBAgIIG3Dp0v+ubHEwDQYJKoZIhvcNAQELBQAwUTELMAkGA1UEBhMCRVMxQjBA
BgNVBAMMOUF1dG9yaWRhZCBkZSBDZXJ0aWZpY2FjaW9uIEZpcm1hcHJvZmVzaW9uYWwgQ0lGIEE2
MjYzNDA2ODAeFw0xNDA5MjMxNTIyMDdaFw0zNjA1MDUxNTIyMDdaMFExCzAJBgNVBAYTAkVTMUIw
QAYDVQQDDDlBdXRvcmlkYWQgZGUgQ2VydGlmaWNhY2lvbiBGaXJtYXByb2Zlc2lvbmFsIENJRiBB
NjI2MzQwNjgwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDKlmuO6vj78aI14H9M2uDD
Utd9thDIAl6zQyrET2qyyhxdKJp4ERppWVevtSBC5IsP5t9bpgOSL/UR5GLXMnE42QQMcas9UX4P
B99jBVzpv5RvwSmCwLTaUbDBPLutN0pcyvFLNg4kq7/DhHf9qFD0sefGL9ItWY16Ck6WaVICqjaY
7Pz6FIMMNx/Jkjd/14Et5cS54D40/mf0PmbR0/RAz15iNA9wBj4gGFrO93IbJWyTdBSTo3OxDqqH
ECNZXyAFGUftaI6SEspd/NYrspI8IM/hX68gvqB2f3bl7BqGYTM+53u0P6APjqK5am+5hyZvQWyI
plD9amML9ZMWGxmPsu2bm8mQ9QEM3xk9Dz44I8kvjwzRAv4bVdZO0I08r0+k8/6vKtMFnXkIoctX
MbScyJCyZ/QYFpM6/EfY0XiWMR+6KwxfXZmtY4laJCB22N/9q06mIqqdXuYnin1oKaPnirjaEbsX
LZmdEyRG98Xi2J+Of8ePdG1asuhy9azuJBCtLxTa/y2aRnFHvkLfuwHb9H/TKI8xWVvTyQKmtFLK
bpf7Q8UIJm+K9Lv9nyiqDdVF8xM6HdjAeI9BZzwelGSuewvF6NkBiDkal4ZkQdU7hwxu+g/GvUgU
vzlN1J5Bto+WHWOWk9mVBngxaJ43BjuAiUVhOSPHG0SjFeUc+JIwuwIDAQABo4HvMIHsMB0GA1Ud
DgQWBBRlzeurNR4APn7VdMActHNHDhpkLzASBgNVHRMBAf8ECDAGAQH/AgEBMIGmBgNVHSAEgZ4w
gZswgZgGBFUdIAAwgY8wLwYIKwYBBQUHAgEWI2h0dHA6Ly93d3cuZmlybWFwcm9mZXNpb25hbC5j
b20vY3BzMFwGCCsGAQUFBwICMFAeTgBQAGEAcwBlAG8AIABkAGUAIABsAGEAIABCAG8AbgBhAG4A
bwB2AGEAIAA0ADcAIABCAGEAcgBjAGUAbABvAG4AYQAgADAAOAAwADEANzAOBgNVHQ8BAf8EBAMC
AQYwDQYJKoZIhvcNAQELBQADggIBAHSHKAIrdx9miWTtj3QuRhy7qPj4Cx2Dtjqn6EWKB7fgPiDL
4QjbEwj4KKE1soCzC1HA01aajTNFSa9J8OA9B3pFE1r/yJfY0xgsfZb43aJlQ3CTkBW6kN/oGbDb
LIpgD7dvlAceHabJhfa9NPhAeGIQcDq+fUs5gakQ1JZBu/hfHAsdCPKxsIl68veg4MSPi3i1O1il
I45PVf42O+AMt8oqMEEgtIDNrvx2ZnOorm7hfNoD6JQg5iKj0B+QXSBTFCZX2lSX3xZEEAEeiGaP
cjiT3SC3NL7X8e5jjkd5KAb881lFJWAiMxujX6i6KtoaPc1A6ozuBRWV1aUsIC+nmCjuRfzxuIgA
LI9C2lHVnOUTaHFFQ4ueCyE8S1wF3BqfmI7avSKecs2tCsvMo2ebKHTEm9caPARYpoKdrcd7b/+A
lun4jWq9GJAd/0kakFI3ky88Al2CdgtR5xbHV/g4+afNmyJU72OwFW1TZQNKXkqgsqeOSQBZONXH
9IBk9W6VULgRfhVwOEqwf9DEMnDAGf/JOC0ULGb0QkTmVXYbgBVX/8Cnp6o5qtjTcNAuuuuUavpf
NIbnYrX9ivAwhZTJryQCL2/W3Wf+47BVTwSYT6RBVuKT0Gro1vP7ZeDOdcQxWQzugsgMYDNKGbqE
ZycPvEJdvSRUDewdcAZfpLz6IHxV
-----END CERTIFICATE-----

vTrus ECC Root CA
=================
-----BEGIN CERTIFICATE-----
MIICDzCCAZWgAwIBAgIUbmq8WapTvpg5Z6LSa6Q75m0c1towCgYIKoZIzj0EAwMwRzELMAkGA1UE
BhMCQ04xHDAaBgNVBAoTE2lUcnVzQ2hpbmEgQ28uLEx0ZC4xGjAYBgNVBAMTEXZUcnVzIEVDQyBS
b290IENBMB4XDTE4MDczMTA3MjY0NFoXDTQzMDczMTA3MjY0NFowRzELMAkGA1UEBhMCQ04xHDAa
BgNVBAoTE2lUcnVzQ2hpbmEgQ28uLEx0ZC4xGjAYBgNVBAMTEXZUcnVzIEVDQyBSb290IENBMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAEZVBKrox5lkqqHAjDo6LN/llWQXf9JpRCux3NCNtzslt188+c
ToL0v/hhJoVs1oVbcnDS/dtitN9Ti72xRFhiQgnH+n9bEOf+QP3A2MMrMudwpremIFUde4BdS49n
TPEQo0IwQDAdBgNVHQ4EFgQUmDnNvtiyjPeyq+GtJK97fKHbH88wDwYDVR0TAQH/BAUwAwEB/zAO
BgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwV53dVvHH4+m4SVBrm2nDb+zDfSXkV5UT
QJtS0zvzQBm8JsctBp61ezaf9SXUY2sAAjEA6dPGnlaaKsyh2j/IZivTWJwghfqrkYpwcBE4YGQL
YgmRWAD5Tfs0aNoJrSEGGJTO
-----END CERTIFICATE-----

vTrus Root CA
=============
-----BEGIN CERTIFICATE-----
MIIFVjCCAz6gAwIBAgIUQ+NxE9izWRRdt86M/TX9b7wFjUUwDQYJKoZIhvcNAQELBQAwQzELMAkG
A1UEBhMCQ04xHDAaBgNVBAoTE2lUcnVzQ2hpbmEgQ28uLEx0ZC4xFjAUBgNVBAMTDXZUcnVzIFJv
b3QgQ0EwHhcNMTgwNzMxMDcyNDA1WhcNNDMwNzMxMDcyNDA1WjBDMQswCQYDVQQGEwJDTjEcMBoG
A1UEChMTaVRydXNDaGluYSBDby4sTHRkLjEWMBQGA1UEAxMNdlRydXMgUm9vdCBDQTCCAiIwDQYJ
KoZIhvcNAQEBBQADggIPADCCAgoCggIBAL1VfGHTuB0EYgWgrmy3cLRB6ksDXhA/kFocizuwZots
SKYcIrrVQJLuM7IjWcmOvFjai57QGfIvWcaMY1q6n6MLsLOaXLoRuBLpDLvPbmyAhykUAyyNJJrI
ZIO1aqwTLDPxn9wsYTwaP3BVm60AUn/PBLn+NvqcwBauYv6WTEN+VRS+GrPSbcKvdmaVayqwlHeF
XgQPYh1jdfdr58tbmnDsPmcF8P4HCIDPKNsFxhQnL4Z98Cfe/+Z+M0jnCx5Y0ScrUw5XSmXX+6KA
YPxMvDVTAWqXcoKv8R1w6Jz1717CbMdHflqUhSZNO7rrTOiwCcJlwp2dCZtOtZcFrPUGoPc2BX70
kLJrxLT5ZOrpGgrIDajtJ8nU57O5q4IikCc9Kuh8kO+8T/3iCiSn3mUkpF3qwHYw03dQ+A0Em5Q2
AXPKBlim0zvc+gRGE1WKyURHuFE5Gi7oNOJ5y1lKCn+8pu8fA2dqWSslYpPZUxlmPCdiKYZNpGvu
/9ROutW04o5IWgAZCfEF2c6Rsffr6TlP9m8EQ5pV9T4FFL2/s1m02I4zhKOQUqqzApVg+QxMaPnu
1RcN+HFXtSXkKe5lXa/R7jwXC1pDxaWG6iSe4gUH3DRCEpHWOXSuTEGC2/KmSNGzm/MzqvOmwMVO
9fSddmPmAsYiS8GVP1BkLFTltvA8Kc9XAgMBAAGjQjBAMB0GA1UdDgQWBBRUYnBj8XWEQ1iO0RYg
scasGrz2iTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOC
AgEAKbqSSaet8PFww+SX8J+pJdVrnjT+5hpk9jprUrIQeBqfTNqK2uwcN1LgQkv7bHbKJAs5EhWd
nxEt/Hlk3ODg9d3gV8mlsnZwUKT+twpw1aA08XXXTUm6EdGz2OyC/+sOxL9kLX1jbhd47F18iMjr
jld22VkE+rxSH0Ws8HqA7Oxvdq6R2xCOBNyS36D25q5J08FsEhvMKar5CKXiNxTKsbhm7xqC5PD4
8acWabfbqWE8n/Uxy+QARsIvdLGx14HuqCaVvIivTDUHKgLKeBRtRytAVunLKmChZwOgzoy8sHJn
xDHO2zTlJQNgJXtxmOTAGytfdELSS8VZCAeHvsXDf+eW2eHcKJfWjwXj9ZtOyh1QRwVTsMo554Wg
icEFOwE30z9J4nfrI8iIZjs9OXYhRvHsXyO466JmdXTBQPfYaJqT4i2pLr0cox7IdMakLXogqzu4
sEb9b91fUlV1YvCXoHzXOP0l382gmxDPi7g4Xl7FtKYCNqEeXxzP4padKar9mK5S4fNBUvupLnKW
nyfjqnN9+BojZns7q2WwMgFLFT49ok8MKzWixtlnEjUwzXYuFrOZnk1PTi07NEPhmg4NpGaXutIc
SkwsKouLgU9xGqndXHt7CMUADTdA43x7VF8vhV929vensBxXVsFy6K2ir40zSbofitzmdHxghm+H
l3s=
-----END CERTIFICATE-----

ISRG Root X2
============
-----BEGIN CERTIFICATE-----
MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQswCQYDVQQGEwJV
UzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElT
UkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVT
MSkwJwYDVQQKEyBJbnRlcm5ldCBTZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNS
RyBSb290IFgyMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0H
ttwW+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9ItgKbppb
d9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZIzj0EAwMDaAAwZQIwe3lORlCEwkSHRhtF
cP9Ymd70/aTSVaYgLXTWNLxBo1BfASdWtL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5
U6VR5CmD1/iQMVtCnwr1/q4AaOeMSQ+2b1tbFfLn
-----END CERTIFICATE-----

HiPKI Root CA - G1
==================
-----BEGIN CERTIFICATE-----
MIIFajCCA1KgAwIBAgIQLd2szmKXlKFD6LDNdmpeYDANBgkqhkiG9w0BAQsFADBPMQswCQYDVQQG
EwJUVzEjMCEGA1UECgwaQ2h1bmdod2EgVGVsZWNvbSBDby4sIEx0ZC4xGzAZBgNVBAMMEkhpUEtJ
IFJvb3QgQ0EgLSBHMTAeFw0xOTAyMjIwOTQ2MDRaFw0zNzEyMzExNTU5NTlaME8xCzAJBgNVBAYT
AlRXMSMwIQYDVQQKDBpDaHVuZ2h3YSBUZWxlY29tIENvLiwgTHRkLjEbMBkGA1UEAwwSSGlQS0kg
Um9vdCBDQSAtIEcxMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA9B5/UnMyDHPkvRN0
o9QwqNCuS9i233VHZvR85zkEHmpwINJaR3JnVfSl6J3VHiGh8Ge6zCFovkRTv4354twvVcg3Px+k
wJyz5HdcoEb+d/oaoDjq7Zpy3iu9lFc6uux55199QmQ5eiY29yTw1S+6lZgRZq2XNdZ1AYDgr/SE
YYwNHl98h5ZeQa/rh+r4XfEuiAU+TCK72h8q3VJGZDnzQs7ZngyzsHeXZJzA9KMuH5UHsBffMNsA
GJZMoYFL3QRtU6M9/Aes1MU3guvklQgZKILSQjqj2FPseYlgSGDIcpJQ3AOPgz+yQlda22rpEZfd
hSi8MEyr48KxRURHH+CKFgeW0iEPU8DtqX7UTuybCeyvQqww1r/REEXgphaypcXTT3OUM3ECoWqj
1jOXTyFjHluP2cFeRXF3D4FdXyGarYPM+l7WjSNfGz1BryB1ZlpK9p/7qxj3ccC2HTHsOyDry+K4
9a6SsvfhhEvyovKTmiKe0xRvNlS9H15ZFblzqMF8b3ti6RZsR1pl8w4Rm0bZ/W3c1pzAtH2lsN0/
Vm+h+fbkEkj9Bn8SV7apI09bA8PgcSojt/ewsTu8mL3WmKgMa/aOEmem8rJY5AIJEzypuxC00jBF
8ez3ABHfZfjcK0NVvxaXxA/VLGGEqnKG/uY6fsI/fe78LxQ+5oXdUG+3Se0CAwEAAaNCMEAwDwYD
VR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU8ncX+l6o/vY9cdVouslGDDjYr7AwDgYDVR0PAQH/BAQD
AgGGMA0GCSqGSIb3DQEBCwUAA4ICAQBQUfB13HAE4/+qddRxosuej6ip0691x1TPOhwEmSKsxBHi
7zNKpiMdDg1H2DfHb680f0+BazVP6XKlMeJ45/dOlBhbQH3PayFUhuaVevvGyuqcSE5XCV0vrPSl
tJczWNWseanMX/mF+lLFjfiRFOs6DRfQUsJ748JzjkZ4Bjgs6FzaZsT0pPBWGTMpWmWSBUdGSquE
wx4noR8RkpkndZMPvDY7l1ePJlsMu5wP1G4wB9TcXzZoZjmDlicmisjEOf6aIW/Vcobpf2Lll07Q
JNBAsNB1CI69aO4I1258EHBGG3zgiLKecoaZAeO/n0kZtCW+VmWuF2PlHt/o/0elv+EmBYTksMCv
5wiZqAxeJoBF1PhoL5aPruJKHJwWDBNvOIf2u8g0X5IDUXlwpt/L9ZlNec1OvFefQ05rLisY+Gpz
jLrFNe85akEez3GoorKGB1s6yeHvP2UEgEcyRHCVTjFnanRbEEV16rCf0OY1/k6fi8wrkkVbbiVg
hUbN0aqwdmaTd5a+g744tiROJgvM7XpWGuDpWsZkrUx6AEhEL7lAuxM+vhV4nYWBSipX3tUZQ9rb
yltHhoMLP7YNdnhzeSJesYAfz77RP1YQmCuVh6EfnWQUYDksswBVLuT1sw5XxJFBAJw/6KXf6vb/
yPCtbVKoF6ubYfwSUTXkJf2vqmqGOQ==
-----END CERTIFICATE-----

GlobalSign ECC Root CA - R4
===========================
-----BEGIN CERTIFICATE-----
MIIB3DCCAYOgAwIBAgINAgPlfvU/k/2lCSGypjAKBggqhkjOPQQDAjBQMSQwIgYDVQQLExtHbG9i
YWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkds
b2JhbFNpZ24wHhcNMTIxMTEzMDAwMDAwWhcNMzgwMTE5MDMxNDA3WjBQMSQwIgYDVQQLExtHbG9i
YWxTaWduIEVDQyBSb290IENBIC0gUjQxEzARBgNVBAoTCkdsb2JhbFNpZ24xEzARBgNVBAMTCkds
b2JhbFNpZ24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS4xnnTj2wlDp8uORkcA6SumuU5BwkW
ymOxuYb4ilfBV85C+nOh92VC/x7BALJucw7/xyHlGKSq2XE/qNS5zowdo0IwQDAOBgNVHQ8BAf8E
BAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUVLB7rUW44kB/+wpu+74zyTyjhNUwCgYI
KoZIzj0EAwIDRwAwRAIgIk90crlgr/HmnKAWBVBfw147bmF0774BxL4YSFlhgjICICadVGNA3jdg
UM/I2O2dgq43mLyjj0xMqTQrbO/7lZsm
-----END CERTIFICATE-----

GTS Root R1
===========
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQswCQYDVQQGEwJV
UzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3Qg
UjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UE
ChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0G
CSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaM
f/vo27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7wCl7raKb0
xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjwTcLCeoiKu7rPWRnWr4+w
B7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0PfyblqAj+lug8aJRT7oM6iCsVlgmy4HqMLnXW
nOunVmSPlk9orj2XwoSPwLxAwAtcvfaHszVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk
9+aCEI3oncKKiPo4Zor8Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zq
kUspzBmkMiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92wO1A
K/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70paDPvOmbsB4om3xPX
V2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrNVjzRlwW5y0vtOUucxD/SVRNuJLDW
cfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQIDAQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQAD
ggIBAJ+qQibbC5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuyh6f88/qBVRRi
ClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM47HLwEXWdyzRSjeZ2axfG34ar
J45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8JZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYci
NuaCp+0KueIHoI17eko8cdLiA6EfMgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5me
LMFrUKTX5hgUvYU/Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJF
fbdT6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ0E6yove+
7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm2tIMPNuzjsmhDYAPexZ3
FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bbbP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3
gm3c
-----END CERTIFICATE-----

GTS Root R3
===========
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPluILrIPglJ209ZjAKBggqhkjOPQQDAzBHMQswCQYDVQQGEwJVUzEi
MCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMw
HhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZ
R29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMwdjAQBgcqhkjO
PQIBBgUrgQQAIgNiAAQfTzOHMymKoYTey8chWEGJ6ladK0uFxh1MJ7x/JlFyb+Kf1qPKzEUURout
736GjOyxfi//qXGdGIRFBEFVbivqJn+7kAHjSxm65FSWRQmx1WyRRK2EE46ajA2ADDL24CejQjBA
MA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTB8Sa6oC2uhYHP0/Eq
Er24Cmf9vDAKBggqhkjOPQQDAwNpADBmAjEA9uEglRR7VKOQFhG/hMjqb2sXnh5GmCCbn9MN2azT
L818+FsuVbu/3ZL3pAzcMeGiAjEA/JdmZuVDFhOD3cffL74UOO0BzrEXGhF16b0DjyZ+hOXJYKaV
11RZt+cRLInUue4X
-----END CERTIFICATE-----

GTS Root R4
===========
-----BEGIN CERTIFICATE-----
MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYDVQQGEwJVUzEi
MCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQw
HhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZ
R29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjO
PQIBBgUrgQQAIgNiAATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzu
hXyiQHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvRHYqjQjBA
MA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSATNbrdP9JNqPV2Py1
PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/C
r8deVl5c1RxYIigL9zC2L7F8AjEA8GE8p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh
4rsUecrNIdSUtUlD
-----END CERTIFICATE-----

Telia Root CA v2
================
-----BEGIN CERTIFICATE-----
MIIFdDCCA1ygAwIBAgIPAWdfJ9b+euPkrL4JWwWeMA0GCSqGSIb3DQEBCwUAMEQxCzAJBgNVBAYT
AkZJMRowGAYDVQQKDBFUZWxpYSBGaW5sYW5kIE95ajEZMBcGA1UEAwwQVGVsaWEgUm9vdCBDQSB2
MjAeFw0xODExMjkxMTU1NTRaFw00MzExMjkxMTU1NTRaMEQxCzAJBgNVBAYTAkZJMRowGAYDVQQK
DBFUZWxpYSBGaW5sYW5kIE95ajEZMBcGA1UEAwwQVGVsaWEgUm9vdCBDQSB2MjCCAiIwDQYJKoZI
hvcNAQEBBQADggIPADCCAgoCggIBALLQPwe84nvQa5n44ndp586dpAO8gm2h/oFlH0wnrI4AuhZ7
6zBqAMCzdGh+sq/H1WKzej9Qyow2RCRj0jbpDIX2Q3bVTKFgcmfiKDOlyzG4OiIjNLh9vVYiQJ3q
9HsDrWj8soFPmNB06o3lfc1jw6P23pLCWBnglrvFxKk9pXSW/q/5iaq9lRdU2HhE8Qx3FZLgmEKn
pNaqIJLNwaCzlrI6hEKNfdWV5Nbb6WLEWLN5xYzTNTODn3WhUidhOPFZPY5Q4L15POdslv5e2QJl
tI5c0BE0312/UqeBAMN/mUWZFdUXyApT7GPzmX3MaRKGwhfwAZ6/hLzRUssbkmbOpFPlob/E2wnW
5olWK8jjfN7j/4nlNW4o6GwLI1GpJQXrSPjdscr6bAhR77cYbETKJuFzxokGgeWKrLDiKca5JLNr
RBH0pUPCTEPlcDaMtjNXepUugqD0XBCzYYP2AgWGLnwtbNwDRm41k9V6lS/eINhbfpSQBGq6WT0E
BXWdN6IOLj3rwaRSg/7Qa9RmjtzG6RJOHSpXqhC8fF6CfaamyfItufUXJ63RDolUK5X6wK0dmBR4
M0KGCqlztft0DbcbMBnEWg4cJ7faGND/isgFuvGqHKI3t+ZIpEYslOqodmJHixBTB0hXbOKSTbau
BcvcwUpej6w9GU7C7WB1K9vBykLVAgMBAAGjYzBhMB8GA1UdIwQYMBaAFHKs5DN5qkWH9v2sHZ7W
xy+G2CQ5MB0GA1UdDgQWBBRyrOQzeapFh/b9rB2e1scvhtgkOTAOBgNVHQ8BAf8EBAMCAQYwDwYD
VR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAgEAoDtZpwmUPjaE0n4vOaWWl/oRrfxn83EJ
8rKJhGdEr7nv7ZbsnGTbMjBvZ5qsfl+yqwE2foH65IRe0qw24GtixX1LDoJt0nZi0f6X+J8wfBj5
tFJ3gh1229MdqfDBmgC9bXXYfef6xzijnHDoRnkDry5023X4blMMA8iZGok1GTzTyVR8qPAs5m4H
eW9q4ebqkYJpCh3DflminmtGFZhb069GHWLIzoBSSRE/yQQSwxN8PzuKlts8oB4KtItUsiRnDe+C
y748fdHif64W1lZYudogsYMVoe+KTTJvQS8TUoKU1xrBeKJR3Stwbbca+few4GeXVtt8YVMJAygC
QMez2P2ccGrGKMOF6eLtGpOg3kuYooQ+BXcBlj37tCAPnHICehIv1aO6UXivKitEZU61/Qrowc15
h2Er3oBXRb9n8ZuRXqWk7FlIEA04x7D6w0RtBPV4UBySllva9bguulvP5fBqnUsvWHMtTy3EHD70
sz+rFQ47GUGKpMFXEmZxTPpT41frYpUJnlTd0cI8Vzy9OK2YZLe4A5pTVmBds9hCG1xLEooc6+t9
xnppxyd/pPiL8uSUZodL6ZQHCRJ5irLrdATczvREWeAWysUsWNc8e89ihmpQfTU2Zqf7N+cox9jQ
raVplI/owd8k+BsHMYeB2F326CjYSlKArBPuUBQemMc=
-----END CERTIFICATE-----

D-TRUST BR Root CA 1 2020
=========================
-----BEGIN CERTIFICATE-----
MIIC2zCCAmCgAwIBAgIQfMmPK4TX3+oPyWWa00tNljAKBggqhkjOPQQDAzBIMQswCQYDVQQGEwJE
RTEVMBMGA1UEChMMRC1UcnVzdCBHbWJIMSIwIAYDVQQDExlELVRSVVNUIEJSIFJvb3QgQ0EgMSAy
MDIwMB4XDTIwMDIxMTA5NDUwMFoXDTM1MDIxMTA5NDQ1OVowSDELMAkGA1UEBhMCREUxFTATBgNV
BAoTDEQtVHJ1c3QgR21iSDEiMCAGA1UEAxMZRC1UUlVTVCBCUiBSb290IENBIDEgMjAyMDB2MBAG
ByqGSM49AgEGBSuBBAAiA2IABMbLxyjR+4T1mu9CFCDhQ2tuda38KwOE1HaTJddZO0Flax7mNCq7
dPYSzuht56vkPE4/RAiLzRZxy7+SmfSk1zxQVFKQhYN4lGdnoxwJGT11NIXe7WB9xwy0QVK5buXu
QqOCAQ0wggEJMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFHOREKv/VbNafAkl1bK6CKBrqx9t
MA4GA1UdDwEB/wQEAwIBBjCBxgYDVR0fBIG+MIG7MD6gPKA6hjhodHRwOi8vY3JsLmQtdHJ1c3Qu
bmV0L2NybC9kLXRydXN0X2JyX3Jvb3RfY2FfMV8yMDIwLmNybDB5oHegdYZzbGRhcDovL2RpcmVj
dG9yeS5kLXRydXN0Lm5ldC9DTj1ELVRSVVNUJTIwQlIlMjBSb290JTIwQ0ElMjAxJTIwMjAyMCxP
PUQtVHJ1c3QlMjBHbWJILEM9REU/Y2VydGlmaWNhdGVyZXZvY2F0aW9ubGlzdDAKBggqhkjOPQQD
AwNpADBmAjEAlJAtE/rhY/hhY+ithXhUkZy4kzg+GkHaQBZTQgjKL47xPoFWwKrY7RjEsK70Pvom
AjEA8yjixtsrmfu3Ubgko6SUeho/5jbiA1czijDLgsfWFBHVdWNbFJWcHwHP2NVypw87
-----END CERTIFICATE-----

D-TRUST EV Root CA 1 2020
=========================
-----BEGIN CERTIFICATE-----
MIIC2zCCAmCgAwIBAgIQXwJB13qHfEwDo6yWjfv/0DAKBggqhkjOPQQDAzBIMQswCQYDVQQGEwJE
RTEVMBMGA1UEChMMRC1UcnVzdCBHbWJIMSIwIAYDVQQDExlELVRSVVNUIEVWIFJvb3QgQ0EgMSAy
MDIwMB4XDTIwMDIxMTEwMDAwMFoXDTM1MDIxMTA5NTk1OVowSDELMAkGA1UEBhMCREUxFTATBgNV
BAoTDEQtVHJ1c3QgR21iSDEiMCAGA1UEAxMZRC1UUlVTVCBFViBSb290IENBIDEgMjAyMDB2MBAG
ByqGSM49AgEGBSuBBAAiA2IABPEL3YZDIBnfl4XoIkqbz52Yv7QFJsnL46bSj8WeeHsxiamJrSc8
ZRCC/N/DnU7wMyPE0jL1HLDfMxddxfCxivnvubcUyilKwg+pf3VlSSowZ/Rk99Yad9rDwpdhQntJ
raOCAQ0wggEJMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFH8QARY3OqQo5FD4pPfsazK2/umL
MA4GA1UdDwEB/wQEAwIBBjCBxgYDVR0fBIG+MIG7MD6gPKA6hjhodHRwOi8vY3JsLmQtdHJ1c3Qu
bmV0L2NybC9kLXRydXN0X2V2X3Jvb3RfY2FfMV8yMDIwLmNybDB5oHegdYZzbGRhcDovL2RpcmVj
dG9yeS5kLXRydXN0Lm5ldC9DTj1ELVRSVVNUJTIwRVYlMjBSb290JTIwQ0ElMjAxJTIwMjAyMCxP
PUQtVHJ1c3QlMjBHbWJILEM9REU/Y2VydGlmaWNhdGVyZXZvY2F0aW9ubGlzdDAKBggqhkjOPQQD
AwNpADBmAjEAyjzGKnXCXnViOTYAYFqLwZOZzNnbQTs7h5kXO9XMT8oi96CAy/m0sRtW9XLS/BnR
AjEAkfcwkz8QRitxpNA7RJvAKQIFskF3UfN5Wp6OFKBOQtJbgfM0agPnIjhQW+0ZT0MW
-----END CERTIFICATE-----

DigiCert TLS ECC P384 Root G5
=============================
-----BEGIN CERTIFICATE-----
MIICGTCCAZ+gAwIBAgIQCeCTZaz32ci5PhwLBCou8zAKBggqhkjOPQQDAzBOMQswCQYDVQQGEwJV
UzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xJjAkBgNVBAMTHURpZ2lDZXJ0IFRMUyBFQ0MgUDM4
NCBSb290IEc1MB4XDTIxMDExNTAwMDAwMFoXDTQ2MDExNDIzNTk1OVowTjELMAkGA1UEBhMCVVMx
FzAVBgNVBAoTDkRpZ2lDZXJ0LCBJbmMuMSYwJAYDVQQDEx1EaWdpQ2VydCBUTFMgRUNDIFAzODQg
Um9vdCBHNTB2MBAGByqGSM49AgEGBSuBBAAiA2IABMFEoc8Rl1Ca3iOCNQfN0MsYndLxf3c1Tzvd
lHJS7cI7+Oz6e2tYIOyZrsn8aLN1udsJ7MgT9U7GCh1mMEy7H0cKPGEQQil8pQgO4CLp0zVozptj
n4S1mU1YoI71VOeVyaNCMEAwHQYDVR0OBBYEFMFRRVBZqz7nLFr6ICISB4CIfBFqMA4GA1UdDwEB
/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMDA2gAMGUCMQCJao1H5+z8blUD2Wds
Jk6Dxv3J+ysTvLd6jLRl0mlpYxNjOyZQLgGheQaRnUi/wr4CMEfDFXuxoJGZSZOoPHzoRgaLLPIx
AJSdYsiJvRmEFOml+wG4DXZDjC5Ty3zfDBeWUA==
-----END CERTIFICATE-----

DigiCert TLS RSA4096 Root G5
============================
-----BEGIN CERTIFICATE-----
MIIFZjCCA06gAwIBAgIQCPm0eKj6ftpqMzeJ3nzPijANBgkqhkiG9w0BAQwFADBNMQswCQYDVQQG
EwJVUzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xJTAjBgNVBAMTHERpZ2lDZXJ0IFRMUyBSU0E0
MDk2IFJvb3QgRzUwHhcNMjEwMTE1MDAwMDAwWhcNNDYwMTE0MjM1OTU5WjBNMQswCQYDVQQGEwJV
UzEXMBUGA1UEChMORGlnaUNlcnQsIEluYy4xJTAjBgNVBAMTHERpZ2lDZXJ0IFRMUyBSU0E0MDk2
IFJvb3QgRzUwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCz0PTJeRGd/fxmgefM1eS8
7IE+ajWOLrfn3q/5B03PMJ3qCQuZvWxX2hhKuHisOjmopkisLnLlvevxGs3npAOpPxG02C+JFvuU
AT27L/gTBaF4HI4o4EXgg/RZG5Wzrn4DReW+wkL+7vI8toUTmDKdFqgpwgscONyfMXdcvyej/Ces
tyu9dJsXLfKB2l2w4SMXPohKEiPQ6s+d3gMXsUJKoBZMpG2T6T867jp8nVid9E6P/DsjyG244gXa
zOvswzH016cpVIDPRFtMbzCe88zdH5RDnU1/cHAN1DrRN/BsnZvAFJNY781BOHW8EwOVfH/jXOnV
DdXifBBiqmvwPXbzP6PosMH976pXTayGpxi0KcEsDr9kvimM2AItzVwv8n/vFfQMFawKsPHTDU9q
TXeXAaDxZre3zu/O7Oyldcqs4+Fj97ihBMi8ez9dLRYiVu1ISf6nL3kwJZu6ay0/nTvEF+cdLvvy
z6b84xQslpghjLSR6Rlgg/IwKwZzUNWYOwbpx4oMYIwo+FKbbuH2TbsGJJvXKyY//SovcfXWJL5/
MZ4PbeiPT02jP/816t9JXkGPhvnxd3lLG7SjXi/7RgLQZhNeXoVPzthwiHvOAbWWl9fNff2C+MIk
wcoBOU+NosEUQB+cZtUMCUbW8tDRSHZWOkPLtgoRObqME2wGtZ7P6wIDAQABo0IwQDAdBgNVHQ4E
FgQUUTMc7TZArxfTJc1paPKvTiM+s0EwDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQEMBQADggIBAGCmr1tfV9qJ20tQqcQjNSH/0GEwhJG3PxDPJY7Jv0Y02cEhJhxw
GXIeo8mH/qlDZJY6yFMECrZBu8RHANmfGBg7sg7zNOok992vIGCukihfNudd5N7HPNtQOa27PShN
lnx2xlv0wdsUpasZYgcYQF+Xkdycx6u1UQ3maVNVzDl92sURVXLFO4uJ+DQtpBflF+aZfTCIITfN
MBc9uPK8qHWgQ9w+iUuQrm0D4ByjoJYJu32jtyoQREtGBzRj7TG5BO6jm5qu5jF49OokYTurWGT/
u4cnYiWB39yhL/btp/96j1EuMPikAdKFOV8BmZZvWltwGUb+hmA+rYAQCd05JS9Yf7vSdPD3Rh9G
OUrYU9DzLjtxpdRv/PNn5AeP3SYZ4Y1b+qOTEZvpyDrDVWiakuFSdjjo4bq9+0/V77PnSIMx8IIh
47a+p6tv75/fTM8BuGJqIz3nCU2AG3swpMPdB380vqQmsvZB6Akd4yCYqjdP//fx4ilwMUc/dNAU
FvohigLVigmUdy7yWSiLfFCSCmZ4OIN1xLVaqBHG5cGdZlXPU8Sv13WFqUITVuwhd4GTWgzqltlJ
yqEI8pc7bZsEGCREjnwB8twl2F6GmrE52/WRMmrRpnCKovfepEWFJqgejF0pW8hL2JpqA15w8oVP
bEtoL8pU9ozaMv7Da4M/OMZ+
-----END CERTIFICATE-----

Certainly Root R1
=================
-----BEGIN CERTIFICATE-----
MIIFRzCCAy+gAwIBAgIRAI4P+UuQcWhlM1T01EQ5t+AwDQYJKoZIhvcNAQELBQAwPTELMAkGA1UE
BhMCVVMxEjAQBgNVBAoTCUNlcnRhaW5seTEaMBgGA1UEAxMRQ2VydGFpbmx5IFJvb3QgUjEwHhcN
MjEwNDAxMDAwMDAwWhcNNDYwNDAxMDAwMDAwWjA9MQswCQYDVQQGEwJVUzESMBAGA1UEChMJQ2Vy
dGFpbmx5MRowGAYDVQQDExFDZXJ0YWlubHkgUm9vdCBSMTCCAiIwDQYJKoZIhvcNAQEBBQADggIP
ADCCAgoCggIBANA21B/q3avk0bbm+yLA3RMNansiExyXPGhjZjKcA7WNpIGD2ngwEc/csiu+kr+O
5MQTvqRoTNoCaBZ0vrLdBORrKt03H2As2/X3oXyVtwxwhi7xOu9S98zTm/mLvg7fMbedaFySpvXl
8wo0tf97ouSHocavFwDvA5HtqRxOcT3Si2yJ9HiG5mpJoM610rCrm/b01C7jcvk2xusVtyWMOvwl
DbMicyF0yEqWYZL1LwsYpfSt4u5BvQF5+paMjRcCMLT5r3gajLQ2EBAHBXDQ9DGQilHFhiZ5shGI
XsXwClTNSaa/ApzSRKft43jvRl5tcdF5cBxGX1HpyTfcX35pe0HfNEXgO4T0oYoKNp43zGJS4YkN
KPl6I7ENPT2a/Z2B7yyQwHtETrtJ4A5KVpK8y7XdeReJkd5hiXSSqOMyhb5OhaRLWcsrxXiOcVTQ
AjeZjOVJ6uBUcqQRBi8LjMFbvrWhsFNunLhgkR9Za/kt9JQKl7XsxXYDVBtlUrpMklZRNaBA2Cnb
rlJ2Oy0wQJuK0EJWtLeIAaSHO1OWzaMWj/Nmqhexx2DgwUMFDO6bW2BvBlyHWyf5QBGenDPBt+U1
VwV/J84XIIwc/PH72jEpSe31C4SnT8H2TsIonPru4K8H+zMReiFPCyEQtkA6qyI6BJyLm4SGcprS
p6XEtHWRqSsjAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1Ud
DgQWBBTgqj8ljZ9EXME66C6ud0yEPmcM9DANBgkqhkiG9w0BAQsFAAOCAgEAuVevuBLaV4OPaAsz
HQNTVfSVcOQrPbA56/qJYv331hgELyE03fFo8NWWWt7CgKPBjcZq91l3rhVkz1t5BXdm6ozTaw3d
8VkswTOlMIAVRQdFGjEitpIAq5lNOo93r6kiyi9jyhXWx8bwPWz8HA2YEGGeEaIi1wrykXprOQ4v
MMM2SZ/g6Q8CRFA3lFV96p/2O7qUpUzpvD5RtOjKkjZUbVwlKNrdrRT90+7iIgXr0PK3aBLXWopB
GsaSpVo7Y0VPv+E6dyIvXL9G+VoDhRNCX8reU9ditaY1BMJH/5n9hN9czulegChB8n3nHpDYT3Y+
gjwN/KUD+nsa2UUeYNrEjvn8K8l7lcUq/6qJ34IxD3L/DCfXCh5WAFAeDJDBlrXYFIW7pw0WwfgH
JBu6haEaBQmAupVjyTrsJZ9/nbqkRxWbRHDxakvWOF5D8xh+UG7pWijmZeZ3Gzr9Hb4DJqPb1OG7
fpYnKx3upPvaJVQTA945xsMfTZDsjxtK0hzthZU4UHlG1sGQUDGpXJpuHfUzVounmdLyyCwzk5Iw
x06MZTMQZBf9JBeW0Y3COmor6xOLRPIh80oat3df1+2IpHLlOR+Vnb5nwXARPbv0+Em34yaXOp/S
X3z7wJl8OSngex2/DaeP0ik0biQVy96QXr8axGbqwua6OV+KmalBWQewLK8=
-----END CERTIFICATE-----

Certainly Root E1
=================
-----BEGIN CERTIFICATE-----
MIIB9zCCAX2gAwIBAgIQBiUzsUcDMydc+Y2aub/M+DAKBggqhkjOPQQDAzA9MQswCQYDVQQGEwJV
UzESMBAGA1UEChMJQ2VydGFpbmx5MRowGAYDVQQDExFDZXJ0YWlubHkgUm9vdCBFMTAeFw0yMTA0
MDEwMDAwMDBaFw00NjA0MDEwMDAwMDBaMD0xCzAJBgNVBAYTAlVTMRIwEAYDVQQKEwlDZXJ0YWlu
bHkxGjAYBgNVBAMTEUNlcnRhaW5seSBSb290IEUxMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE3m/4
fxzf7flHh4axpMCK+IKXgOqPyEpeKn2IaKcBYhSRJHpcnqMXfYqGITQYUBsQ3tA3SybHGWCA6TS9
YBk2QNYphwk8kXr2vBMj3VlOBF7PyAIcGFPBMdjaIOlEjeR2o0IwQDAOBgNVHQ8BAf8EBAMCAQYw
DwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQU8ygYy2R17ikq6+2uI1g4hevIIgcwCgYIKoZIzj0E
AwMDaAAwZQIxALGOWiDDshliTd6wT99u0nCK8Z9+aozmut6Dacpps6kFtZaSF4fC0urQe87YQVt8
rgIwRt7qy12a7DLCZRawTDBcMPPaTnOGBtjOiQRINzf43TNRnXCve1XYAS59BWQOhriR
-----END CERTIFICATE-----

Security Communication ECC RootCA1
==================================
-----BEGIN CERTIFICATE-----
MIICODCCAb6gAwIBAgIJANZdm7N4gS7rMAoGCCqGSM49BAMDMGExCzAJBgNVBAYTAkpQMSUwIwYD
VQQKExxTRUNPTSBUcnVzdCBTeXN0ZW1zIENPLixMVEQuMSswKQYDVQQDEyJTZWN1cml0eSBDb21t
dW5pY2F0aW9uIEVDQyBSb290Q0ExMB4XDTE2MDYxNjA1MTUyOFoXDTM4MDExODA1MTUyOFowYTEL
MAkGA1UEBhMCSlAxJTAjBgNVBAoTHFNFQ09NIFRydXN0IFN5c3RlbXMgQ08uLExURC4xKzApBgNV
BAMTIlNlY3VyaXR5IENvbW11bmljYXRpb24gRUNDIFJvb3RDQTEwdjAQBgcqhkjOPQIBBgUrgQQA
IgNiAASkpW9gAwPDvTH00xecK4R1rOX9PVdu12O/5gSJko6BnOPpR27KkBLIE+CnnfdldB9sELLo
5OnvbYUymUSxXv3MdhDYW72ixvnWQuRXdtyQwjWpS4g8EkdtXP9JTxpKULGjQjBAMB0GA1UdDgQW
BBSGHOf+LaVKiwj+KBH6vqNm+GBZLzAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAK
BggqhkjOPQQDAwNoADBlAjAVXUI9/Lbu9zuxNuie9sRGKEkz0FhDKmMpzE2xtHqiuQ04pV1IKv3L
snNdo4gIxwwCMQDAqy0Obe0YottT6SXbVQjgUMzfRGEWgqtJsLKB7HOHeLRMsmIbEvoWTSVLY70e
N9k=
-----END CERTIFICATE-----

BJCA Global Root CA1
====================
-----BEGIN CERTIFICATE-----
MIIFdDCCA1ygAwIBAgIQVW9l47TZkGobCdFsPsBsIDANBgkqhkiG9w0BAQsFADBUMQswCQYDVQQG
EwJDTjEmMCQGA1UECgwdQkVJSklORyBDRVJUSUZJQ0FURSBBVVRIT1JJVFkxHTAbBgNVBAMMFEJK
Q0EgR2xvYmFsIFJvb3QgQ0ExMB4XDTE5MTIxOTAzMTYxN1oXDTQ0MTIxMjAzMTYxN1owVDELMAkG
A1UEBhMCQ04xJjAkBgNVBAoMHUJFSUpJTkcgQ0VSVElGSUNBVEUgQVVUSE9SSVRZMR0wGwYDVQQD
DBRCSkNBIEdsb2JhbCBSb290IENBMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAPFm
CL3ZxRVhy4QEQaVpN3cdwbB7+sN3SJATcmTRuHyQNZ0YeYjjlwE8R4HyDqKYDZ4/N+AZspDyRhyS
sTphzvq3Rp4Dhtczbu33RYx2N95ulpH3134rhxfVizXuhJFyV9xgw8O558dnJCNPYwpj9mZ9S1Wn
P3hkSWkSl+BMDdMJoDIwOvqfwPKcxRIqLhy1BDPapDgRat7GGPZHOiJBhyL8xIkoVNiMpTAK+BcW
yqw3/XmnkRd4OJmtWO2y3syJfQOcs4ll5+M7sSKGjwZteAf9kRJ/sGsciQ35uMt0WwfCyPQ10WRj
eulumijWML3mG90Vr4TqnMfK9Q7q8l0ph49pczm+LiRvRSGsxdRpJQaDrXpIhRMsDQa4bHlW/KNn
MoH1V6XKV0Jp6VwkYe/iMBhORJhVb3rCk9gZtt58R4oRTklH2yiUAguUSiz5EtBP6DF+bHq/pj+b
OT0CFqMYs2esWz8sgytnOYFcuX6U1WTdno9uruh8W7TXakdI136z1C2OVnZOz2nxbkRs1CTqjSSh
GL+9V/6pmTW12xB3uD1IutbB5/EjPtffhZ0nPNRAvQoMvfXnjSXWgXSHRtQpdaJCbPdzied9v3pK
H9MiyRVVz99vfFXQpIsHETdfg6YmV6YBW37+WGgHqel62bno/1Afq8K0wM7o6v0PvY1NuLxxAgMB
AAGjQjBAMB0GA1UdDgQWBBTF7+3M2I0hxkjk49cULqcWk+WYATAPBgNVHRMBAf8EBTADAQH/MA4G
A1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAgEAUoKsITQfI/Ki2Pm4rzc2IInRNwPWaZ+4
YRC6ojGYWUfo0Q0lHhVBDOAqVdVXUsv45Mdpox1NcQJeXyFFYEhcCY5JEMEE3KliawLwQ8hOnThJ
dMkycFRtwUf8jrQ2ntScvd0g1lPJGKm1Vrl2i5VnZu69mP6u775u+2D2/VnGKhs/I0qUJDAnyIm8
60Qkmss9vk/Ves6OF8tiwdneHg56/0OGNFK8YT88X7vZdrRTvJez/opMEi4r89fO4aL/3Xtw+zuh
TaRjAv04l5U/BXCga99igUOLtFkNSoxUnMW7gZ/NfaXvCyUeOiDbHPwfmGcCCtRzRBPbUYQaVQNW
4AB+dAb/OMRyHdOoP2gxXdMJxy6MW2Pg6Nwe0uxhHvLe5e/2mXZgLR6UcnHGCyoyx5JO1UbXHfmp
GQrI+pXObSOYqgs4rZpWDW+N8TEAiMEXnM0ZNjX+VVOg4DwzX5Ze4jLp3zO7Bkqp2IRzznfSxqxx
4VyjHQy7Ct9f4qNx2No3WqB4K/TUfet27fJhcKVlmtOJNBir+3I+17Q9eVzYH6Eze9mCUAyTF6ps
3MKCuwJXNq+YJyo5UOGwifUll35HaBC07HPKs5fRJNz2YqAo07WjuGS3iGJCz51TzZm+ZGiPTx4S
SPfSKcOYKMryMguTjClPPGAyzQWWYezyr/6zcCwupvI=
-----END CERTIFICATE-----

BJCA Global Root CA2
====================
-----BEGIN CERTIFICATE-----
MIICJTCCAaugAwIBAgIQLBcIfWQqwP6FGFkGz7RK6zAKBggqhkjOPQQDAzBUMQswCQYDVQQGEwJD
TjEmMCQGA1UECgwdQkVJSklORyBDRVJUSUZJQ0FURSBBVVRIT1JJVFkxHTAbBgNVBAMMFEJKQ0Eg
R2xvYmFsIFJvb3QgQ0EyMB4XDTE5MTIxOTAzMTgyMVoXDTQ0MTIxMjAzMTgyMVowVDELMAkGA1UE
BhMCQ04xJjAkBgNVBAoMHUJFSUpJTkcgQ0VSVElGSUNBVEUgQVVUSE9SSVRZMR0wGwYDVQQDDBRC
SkNBIEdsb2JhbCBSb290IENBMjB2MBAGByqGSM49AgEGBSuBBAAiA2IABJ3LgJGNU2e1uVCxA/jl
SR9BIgmwUVJY1is0j8USRhTFiy8shP8sbqjV8QnjAyEUxEM9fMEsxEtqSs3ph+B99iK++kpRuDCK
/eHeGBIK9ke35xe/J4rUQUyWPGCWwf0VHKNCMEAwHQYDVR0OBBYEFNJKsVF/BvDRgh9Obl+rg/xI
1LCRMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMBq8
W9f+qdJUDkpd0m2xQNz0Q9XSSpkZElaA94M04TVOSG0ED1cxMDAtsaqdAzjbBgIxAMvMh1PLet8g
UXOQwKhbYdDFUDn9hf7B43j4ptZLvZuHjw/l1lOWqzzIQNph91Oj9w==
-----END CERTIFICATE-----

Sectigo Public Server Authentication Root E46
=============================================
-----BEGIN CERTIFICATE-----
MIICOjCCAcGgAwIBAgIQQvLM2htpN0RfFf51KBC49DAKBggqhkjOPQQDAzBfMQswCQYDVQQGEwJH
QjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1TZWN0aWdvIFB1YmxpYyBTZXJ2
ZXIgQXV0aGVudGljYXRpb24gUm9vdCBFNDYwHhcNMjEwMzIyMDAwMDAwWhcNNDYwMzIxMjM1OTU5
WjBfMQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1TZWN0
aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBFNDYwdjAQBgcqhkjOPQIBBgUr
gQQAIgNiAAR2+pmpbiDt+dd34wc7qNs9Xzjoq1WmVk/WSOrsfy2qw7LFeeyZYX8QeccCWvkEN/U0
NSt3zn8gj1KjAIns1aeibVvjS5KToID1AZTc8GgHHs3u/iVStSBDHBv+6xnOQ6OjQjBAMB0GA1Ud
DgQWBBTRItpMWfFLXyY4qp3W7usNw/upYTAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAwNnADBkAjAn7qRaqCG76UeXlImldCBteU/IvZNeWBj7LRoAasm4PdCkT0RH
lAFWovgzJQxC36oCMB3q4S6ILuH5px0CMk7yn2xVdOOurvulGu7t0vzCAxHrRVxgED1cf5kDW21U
SAGKcw==
-----END CERTIFICATE-----

Sectigo Public Server Authentication Root R46
=============================================
-----BEGIN CERTIFICATE-----
MIIFijCCA3KgAwIBAgIQdY39i658BwD6qSWn4cetFDANBgkqhkiG9w0BAQwFADBfMQswCQYDVQQG
EwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1TZWN0aWdvIFB1YmxpYyBT
ZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYwHhcNMjEwMzIyMDAwMDAwWhcNNDYwMzIxMjM1
OTU5WjBfMQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1T
ZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYwggIiMA0GCSqGSIb3
DQEBAQUAA4ICDwAwggIKAoICAQCTvtU2UnXYASOgHEdCSe5jtrch/cSV1UgrJnwUUxDaef0rty2k
1Cz66jLdScK5vQ9IPXtamFSvnl0xdE8H/FAh3aTPaE8bEmNtJZlMKpnzSDBh+oF8HqcIStw+Kxwf
GExxqjWMrfhu6DtK2eWUAtaJhBOqbchPM8xQljeSM9xfiOefVNlI8JhD1mb9nxc4Q8UBUQvX4yMP
FF1bFOdLvt30yNoDN9HWOaEhUTCDsG3XME6WW5HwcCSrv0WBZEMNvSE6Lzzpng3LILVCJ8zab5vu
ZDCQOc2TZYEhMbUjUDM3IuM47fgxMMxF/mL50V0yeUKH32rMVhlATc6qu/m1dkmU8Sf4kaWD5Qaz
Yw6A3OASVYCmO2a0OYctyPDQ0RTp5A1NDvZdV3LFOxxHVp3i1fuBYYzMTYCQNFu31xR13NgESJ/A
wSiItOkcyqex8Va3e0lMWeUgFaiEAin6OJRpmkkGj80feRQXEgyDet4fsZfu+Zd4KKTIRJLpfSYF
plhym3kT2BFfrsU4YjRosoYwjviQYZ4ybPUHNs2iTG7sijbt8uaZFURww3y8nDnAtOFr94MlI1fZ
EoDlSfB1D++N6xybVCi0ITz8fAr/73trdf+LHaAZBav6+CuBQug4urv7qv094PPK306Xlynt8xhW
6aWWrL3DkJiy4Pmi1KZHQ3xtzwIDAQABo0IwQDAdBgNVHQ4EFgQUVnNYZJX5khqwEioEYnmhQBWI
IUkwDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEMBQADggIBAC9c
mTz8Bl6MlC5w6tIyMY208FHVvArzZJ8HXtXBc2hkeqK5Duj5XYUtqDdFqij0lgVQYKlJfp/imTYp
E0RHap1VIDzYm/EDMrraQKFz6oOht0SmDpkBm+S8f74TlH7Kph52gDY9hAaLMyZlbcp+nv4fjFg4
exqDsQ+8FxG75gbMY/qB8oFM2gsQa6H61SilzwZAFv97fRheORKkU55+MkIQpiGRqRxOF3yEvJ+M
0ejf5lG5Nkc/kLnHvALcWxxPDkjBJYOcCj+esQMzEhonrPcibCTRAUH4WAP+JWgiH5paPHxsnnVI
84HxZmduTILA7rpXDhjvLpr3Etiga+kFpaHpaPi8TD8SHkXoUsCjvxInebnMMTzD9joiFgOgyY9m
pFuiTdaBJQbpdqQACj7LzTWb4OE4y2BThihCQRxEV+ioratF4yUQvNs+ZUH7G6aXD+u5dHn5Hrwd
Vw1Hr8Mvn4dGp+smWg9WY7ViYG4A++MnESLn/pmPNPW56MORcr3Ywx65LvKRRFHQV80MNNVIIb/b
E/FmJUNS0nAiNs2fxBx1IK1jcmMGDw4nztJqDby1ORrp0XZ60Vzk50lJLVU3aPAaOpg+VBeHVOmm
J1CJeyAvP/+/oYtKR5j/K3tJPsMpRmAYQqszKbrAKbkTidOIijlBO8n9pu0f9GBj39ItVQGL
-----END CERTIFICATE-----

SSL.com TLS RSA Root CA 2022
============================
-----BEGIN CERTIFICATE-----
MIIFiTCCA3GgAwIBAgIQb77arXO9CEDii02+1PdbkTANBgkqhkiG9w0BAQsFADBOMQswCQYDVQQG
EwJVUzEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMSUwIwYDVQQDDBxTU0wuY29tIFRMUyBSU0Eg
Um9vdCBDQSAyMDIyMB4XDTIyMDgyNTE2MzQyMloXDTQ2MDgxOTE2MzQyMVowTjELMAkGA1UEBhMC
VVMxGDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjElMCMGA1UEAwwcU1NMLmNvbSBUTFMgUlNBIFJv
b3QgQ0EgMjAyMjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANCkCXJPQIgSYT41I57u
9nTPL3tYPc48DRAokC+X94xI2KDYJbFMsBFMF3NQ0CJKY7uB0ylu1bUJPiYYf7ISf5OYt6/wNr/y
7hienDtSxUcZXXTzZGbVXcdotL8bHAajvI9AI7YexoS9UcQbOcGV0insS657Lb85/bRi3pZ7Qcac
oOAGcvvwB5cJOYF0r/c0WRFXCsJbwST0MXMwgsadugL3PnxEX4MN8/HdIGkWCVDi1FW24IBydm5M
R7d1VVm0U3TZlMZBrViKMWYPHqIbKUBOL9975hYsLfy/7PO0+r4Y9ptJ1O4Fbtk085zx7AGL0SDG
D6C1vBdOSHtRwvzpXGk3R2azaPgVKPC506QVzFpPulJwoxJF3ca6TvvC0PeoUidtbnm1jPx7jMEW
TO6Af77wdr5BUxIzrlo4QqvXDz5BjXYHMtWrifZOZ9mxQnUjbvPNQrL8VfVThxc7wDNY8VLS+YCk
8OjwO4s4zKTGkH8PnP2L0aPP2oOnaclQNtVcBdIKQXTbYxE3waWglksejBYSd66UNHsef8JmAOSq
g+qKkK3ONkRN0VHpvB/zagX9wHQfJRlAUW7qglFA35u5CCoGAtUjHBPW6dvbxrB6y3snm/vg1UYk
7RBLY0ulBY+6uB0rpvqR4pJSvezrZ5dtmi2fgTIFZzL7SAg/2SW4BCUvAgMBAAGjYzBhMA8GA1Ud
EwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAU+y437uOEeicuzRk1sTN8/9REQrkwHQYDVR0OBBYEFPsu
N+7jhHonLs0ZNbEzfP/UREK5MA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsFAAOCAgEAjYlt
hEUY8U+zoO9opMAdrDC8Z2awms22qyIZZtM7QbUQnRC6cm4pJCAcAZli05bg4vsMQtfhWsSWTVTN
j8pDU/0quOr4ZcoBwq1gaAafORpR2eCNJvkLTqVTJXojpBzOCBvfR4iyrT7gJ4eLSYwfqUdYe5by
iB0YrrPRpgqU+tvT5TgKa3kSM/tKWTcWQA673vWJDPFs0/dRa1419dvAJuoSc06pkZCmF8NsLzjU
o3KUQyxi4U5cMj29TH0ZR6LDSeeWP4+a0zvkEdiLA9z2tmBVGKaBUfPhqBVq6+AL8BQx1rmMRTqo
ENjwuSfr98t67wVylrXEj5ZzxOhWc5y8aVFjvO9nHEMaX3cZHxj4HCUp+UmZKbaSPaKDN7Egkaib
MOlqbLQjk2UEqxHzDh1TJElTHaE/nUiSEeJ9DU/1172iWD54nR4fK/4huxoTtrEoZP2wAgDHbICi
vRZQIA9ygV/MlP+7mea6kMvq+cYMwq7FGc4zoWtcu358NFcXrfA/rs3qr5nsLFR+jM4uElZI7xc7
P0peYNLcdDa8pUNjyw9bowJWCZ4kLOGGgYz+qxcs+sjiMho6/4UIyYOf8kpIEFR3N+2ivEC+5BB0
9+Rbu7nzifmPQdjH5FCQNYA+HLhNkNPU98OwoX6EyneSMSy4kLGCenROmxMmtNVQZlR4rmA=
-----END CERTIFICATE-----

SSL.com TLS ECC Root CA 2022
============================
-----BEGIN CERTIFICATE-----
MIICOjCCAcCgAwIBAgIQFAP1q/s3ixdAW+JDsqXRxDAKBggqhkjOPQQDAzBOMQswCQYDVQQGEwJV
UzEYMBYGA1UECgwPU1NMIENvcnBvcmF0aW9uMSUwIwYDVQQDDBxTU0wuY29tIFRMUyBFQ0MgUm9v
dCBDQSAyMDIyMB4XDTIyMDgyNTE2MzM0OFoXDTQ2MDgxOTE2MzM0N1owTjELMAkGA1UEBhMCVVMx
GDAWBgNVBAoMD1NTTCBDb3Jwb3JhdGlvbjElMCMGA1UEAwwcU1NMLmNvbSBUTFMgRUNDIFJvb3Qg
Q0EgMjAyMjB2MBAGByqGSM49AgEGBSuBBAAiA2IABEUpNXP6wrgjzhR9qLFNoFs27iosU8NgCTWy
JGYmacCzldZdkkAZDsalE3D07xJRKF3nzL35PIXBz5SQySvOkkJYWWf9lCcQZIxPBLFNSeR7T5v1
5wj4A4j3p8OSSxlUgaNjMGEwDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBSJjy+j6CugFFR7
81a4Jl9nOAuc0DAdBgNVHQ4EFgQUiY8vo+groBRUe/NWuCZfZzgLnNAwDgYDVR0PAQH/BAQDAgGG
MAoGCCqGSM49BAMDA2gAMGUCMFXjIlbp15IkWE8elDIPDAI2wv2sdDJO4fscgIijzPvX6yv/N33w
7deedWo1dlJF4AIxAMeNb0Igj762TVntd00pxCAgRWSGOlDGxK0tk/UYfXLtqc/ErFc2KAhl3zx5
Zn6g6g==
-----END CERTIFICATE-----

Atos TrustedRoot Root CA ECC TLS 2021
=====================================
-----BEGIN CERTIFICATE-----
MIICFTCCAZugAwIBAgIQPZg7pmY9kGP3fiZXOATvADAKBggqhkjOPQQDAzBMMS4wLAYDVQQDDCVB
dG9zIFRydXN0ZWRSb290IFJvb3QgQ0EgRUNDIFRMUyAyMDIxMQ0wCwYDVQQKDARBdG9zMQswCQYD
VQQGEwJERTAeFw0yMTA0MjIwOTI2MjNaFw00MTA0MTcwOTI2MjJaMEwxLjAsBgNVBAMMJUF0b3Mg
VHJ1c3RlZFJvb3QgUm9vdCBDQSBFQ0MgVExTIDIwMjExDTALBgNVBAoMBEF0b3MxCzAJBgNVBAYT
AkRFMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEloZYKDcKZ9Cg3iQZGeHkBQcfl+3oZIK59sRxUM6K
DP/XtXa7oWyTbIOiaG6l2b4siJVBzV3dscqDY4PMwL502eCdpO5KTlbgmClBk1IQ1SQ4AjJn8ZQS
b+/Xxd4u/RmAo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBR2KCXWfeBmmnoJsmo7jjPX
NtNPojAOBgNVHQ8BAf8EBAMCAYYwCgYIKoZIzj0EAwMDaAAwZQIwW5kp85wxtolrbNa9d+F851F+
uDrNozZffPc8dz7kUK2o59JZDCaOMDtuCCrCp1rIAjEAmeMM56PDr9NJLkaCI2ZdyQAUEv049OGY
a3cpetskz2VAv9LcjBHo9H1/IISpQuQo
-----END CERTIFICATE-----

Atos TrustedRoot Root CA RSA TLS 2021
=====================================
-----BEGIN CERTIFICATE-----
MIIFZDCCA0ygAwIBAgIQU9XP5hmTC/srBRLYwiqipDANBgkqhkiG9w0BAQwFADBMMS4wLAYDVQQD
DCVBdG9zIFRydXN0ZWRSb290IFJvb3QgQ0EgUlNBIFRMUyAyMDIxMQ0wCwYDVQQKDARBdG9zMQsw
CQYDVQQGEwJERTAeFw0yMTA0MjIwOTIxMTBaFw00MTA0MTcwOTIxMDlaMEwxLjAsBgNVBAMMJUF0
b3MgVHJ1c3RlZFJvb3QgUm9vdCBDQSBSU0EgVExTIDIwMjExDTALBgNVBAoMBEF0b3MxCzAJBgNV
BAYTAkRFMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtoAOxHm9BYx9sKOdTSJNy/BB
l01Z4NH+VoyX8te9j2y3I49f1cTYQcvyAh5x5en2XssIKl4w8i1mx4QbZFc4nXUtVsYvYe+W/CBG
vevUez8/fEc4BKkbqlLfEzfTFRVOvV98r61jx3ncCHvVoOX3W3WsgFWZkmGbzSoXfduP9LVq6hdK
ZChmFSlsAvFr1bqjM9xaZ6cF4r9lthawEO3NUDPJcFDsGY6wx/J0W2tExn2WuZgIWWbeKQGb9Cpt
0xU6kGpn8bRrZtkh68rZYnxGEFzedUlnnkL5/nWpo63/dgpnQOPF943HhZpZnmKaau1Fh5hnstVK
PNe0OwANwI8f4UDErmwh3El+fsqyjW22v5MvoVw+j8rtgI5Y4dtXz4U2OLJxpAmMkokIiEjxQGMY
sluMWuPD0xeqqxmjLBvk1cbiZnrXghmmOxYsL3GHX0WelXOTwkKBIROW1527k2gV+p2kHYzygeBY
Br3JtuP2iV2J+axEoctr+hbxx1A9JNr3w+SH1VbxT5Aw+kUJWdo0zuATHAR8ANSbhqRAvNncTFd+
rrcztl524WWLZt+NyteYr842mIycg5kDcPOvdO3GDjbnvezBc6eUWsuSZIKmAMFwoW4sKeFYV+xa
fJlrJaSQOoD0IJ2azsct+bJLKZWD6TWNp0lIpw9MGZHQ9b8Q4HECAwEAAaNCMEAwDwYDVR0TAQH/
BAUwAwEB/zAdBgNVHQ4EFgQUdEmZ0f+0emhFdcN+tNzMzjkz2ggwDgYDVR0PAQH/BAQDAgGGMA0G
CSqGSIb3DQEBDAUAA4ICAQAjQ1MkYlxt/T7Cz1UAbMVWiLkO3TriJQ2VSpfKgInuKs1l+NsW4AmS
4BjHeJi78+xCUvuppILXTdiK/ORO/auQxDh1MoSf/7OwKwIzNsAQkG8dnK/haZPso0UvFJ/1TCpl
Q3IM98P4lYsU84UgYt1UU90s3BiVaU+DR3BAM1h3Egyi61IxHkzJqM7F78PRreBrAwA0JrRUITWX
AdxfG/F851X6LWh3e9NpzNMOa7pNdkTWwhWaJuywxfW70Xp0wmzNxbVe9kzmWy2B27O3Opee7c9G
slA9hGCZcbUztVdF5kJHdWoOsAgMrr3e97sPWD2PAzHoPYJQyi9eDF20l74gNAf0xBLh7tew2Vkt
afcxBPTy+av5EzH4AXcOPUIjJsyacmdRIXrMPIWo6iFqO9taPKU0nprALN+AnCng33eU0aKAQv9q
TFsR0PXNor6uzFFcw9VUewyu1rkGd4Di7wcaaMxZUa1+XGdrudviB0JbuAEFWDlN5LuYo7Ey7Nmj
1m+UI/87tyll5gfp77YZ6ufCOB0yiJA8EytuzO+rdwY0d4RPcuSBhPm5dDTedk+SKlOxJTnbPP/l
PqYO5Wue/9vsL3SD3460s6neFE3/MaNFcyT6lSnMEpcEoji2jbDwN/zIIX8/syQbPYtuzE2wFg2W
HYMfRsCbvUOZ58SWLs5fyQ==
-----END CERTIFICATE-----

TrustAsia Global Root CA G3
===========================
-----BEGIN CERTIFICATE-----
MIIFpTCCA42gAwIBAgIUZPYOZXdhaqs7tOqFhLuxibhxkw8wDQYJKoZIhvcNAQEMBQAwWjELMAkG
A1UEBhMCQ04xJTAjBgNVBAoMHFRydXN0QXNpYSBUZWNobm9sb2dpZXMsIEluYy4xJDAiBgNVBAMM
G1RydXN0QXNpYSBHbG9iYWwgUm9vdCBDQSBHMzAeFw0yMTA1MjAwMjEwMTlaFw00NjA1MTkwMjEw
MTlaMFoxCzAJBgNVBAYTAkNOMSUwIwYDVQQKDBxUcnVzdEFzaWEgVGVjaG5vbG9naWVzLCBJbmMu
MSQwIgYDVQQDDBtUcnVzdEFzaWEgR2xvYmFsIFJvb3QgQ0EgRzMwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQDAMYJhkuSUGwoqZdC+BqmHO1ES6nBBruL7dOoKjbmzTNyPtxNST1QY4Sxz
lZHFZjtqz6xjbYdT8PfxObegQ2OwxANdV6nnRM7EoYNl9lA+sX4WuDqKAtCWHwDNBSHvBm3dIZwZ
Q0WhxeiAysKtQGIXBsaqvPPW5vxQfmZCHzyLpnl5hkA1nyDvP+uLRx+PjsXUjrYsyUQE49RDdT/V
P68czH5GX6zfZBCK70bwkPAPLfSIC7Epqq+FqklYqL9joDiR5rPmd2jE+SoZhLsO4fWvieylL1Ag
dB4SQXMeJNnKziyhWTXAyB1GJ2Faj/lN03J5Zh6fFZAhLf3ti1ZwA0pJPn9pMRJpxx5cynoTi+jm
9WAPzJMshH/x/Gr8m0ed262IPfN2dTPXS6TIi/n1Q1hPy8gDVI+lhXgEGvNz8teHHUGf59gXzhqc
D0r83ERoVGjiQTz+LISGNzzNPy+i2+f3VANfWdP3kXjHi3dqFuVJhZBFcnAvkV34PmVACxmZySYg
WmjBNb9Pp1Hx2BErW+Canig7CjoKH8GB5S7wprlppYiU5msTf9FkPz2ccEblooV7WIQn3MSAPmea
mseaMQ4w7OYXQJXZRe0Blqq/DPNL0WP3E1jAuPP6Z92bfW1K/zJMtSU7/xxnD4UiWQWRkUF3gdCF
TIcQcf+eQxuulXUtgQIDAQABo2MwYTAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFEDk5PIj
7zjKsK5Xf/IhMBY027ySMB0GA1UdDgQWBBRA5OTyI+84yrCuV3/yITAWNNu8kjAOBgNVHQ8BAf8E
BAMCAQYwDQYJKoZIhvcNAQEMBQADggIBACY7UeFNOPMyGLS0XuFlXsSUT9SnYaP4wM8zAQLpw6o1
D/GUE3d3NZ4tVlFEbuHGLige/9rsR82XRBf34EzC4Xx8MnpmyFq2XFNFV1pF1AWZLy4jVe5jaN/T
G3inEpQGAHUNcoTpLrxaatXeL1nHo+zSh2bbt1S1JKv0Q3jbSwTEb93mPmY+KfJLaHEih6D4sTNj
duMNhXJEIlU/HHzp/LgV6FL6qj6jITk1dImmasI5+njPtqzn59ZW/yOSLlALqbUHM/Q4X6RJpstl
cHboCoWASzY9M/eVVHUl2qzEc4Jl6VL1XP04lQJqaTDFHApXB64ipCz5xUG3uOyfT0gA+QEEVcys
+TIxxHWVBqB/0Y0n3bOppHKH/lmLmnp0Ft0WpWIp6zqW3IunaFnT63eROfjXy9mPX1onAX1daBli
2MjN9LdyR75bl87yraKZk62Uy5P2EgmVtqvXO9A/EcswFi55gORngS1d7XB4tmBZrOFdRWOPyN9y
aFvqHbgB8X7754qz41SgOAngPN5C8sLtLpvzHzW2NtjjgKGLzZlkD8Kqq7HK9W+eQ42EVJmzbsAS
ZthwEPEGNTNDqJwuuhQxzhB/HIbjj9LV+Hfsm6vxL2PZQl/gZ4FkkfGXL/xuJvYz+NO1+MRiqzFR
JQJ6+N1rZdVtTTDIZbpoFGWsJwt0ivKH
-----END CERTIFICATE-----

TrustAsia Global Root CA G4
===========================
-----BEGIN CERTIFICATE-----
MIICVTCCAdygAwIBAgIUTyNkuI6XY57GU4HBdk7LKnQV1tcwCgYIKoZIzj0EAwMwWjELMAkGA1UE
BhMCQ04xJTAjBgNVBAoMHFRydXN0QXNpYSBUZWNobm9sb2dpZXMsIEluYy4xJDAiBgNVBAMMG1Ry
dXN0QXNpYSBHbG9iYWwgUm9vdCBDQSBHNDAeFw0yMTA1MjAwMjEwMjJaFw00NjA1MTkwMjEwMjJa
MFoxCzAJBgNVBAYTAkNOMSUwIwYDVQQKDBxUcnVzdEFzaWEgVGVjaG5vbG9naWVzLCBJbmMuMSQw
IgYDVQQDDBtUcnVzdEFzaWEgR2xvYmFsIFJvb3QgQ0EgRzQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AATxs8045CVD5d4ZCbuBeaIVXxVjAd7Cq92zphtnS4CDr5nLrBfbK5bKfFJV4hrhPVbwLxYI+hW8
m7tH5j/uqOFMjPXTNvk4XatwmkcN4oFBButJ+bAp3TPsUKV/eSm4IJijYzBhMA8GA1UdEwEB/wQF
MAMBAf8wHwYDVR0jBBgwFoAUpbtKl86zK3+kMd6Xg1mDpm9xy94wHQYDVR0OBBYEFKW7SpfOsyt/
pDHel4NZg6ZvccveMA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAwNnADBkAjBe8usGzEkxn0AA
bbd+NvBNEU/zy4k6LHiRUKNbwMp1JvK/kF0LgoxgKJ/GcJpo5PECMFxYDlZ2z1jD1xCMuo6u47xk
dUfFVZDj/bpV6wfEU6s3qe4hsiFbYI89MvHVI5TWWA==
-----END CERTIFICATE-----

Telekom Security TLS ECC Root 2020
==================================
-----BEGIN CERTIFICATE-----
MIICQjCCAcmgAwIBAgIQNjqWjMlcsljN0AFdxeVXADAKBggqhkjOPQQDAzBjMQswCQYDVQQGEwJE
RTEnMCUGA1UECgweRGV1dHNjaGUgVGVsZWtvbSBTZWN1cml0eSBHbWJIMSswKQYDVQQDDCJUZWxl
a29tIFNlY3VyaXR5IFRMUyBFQ0MgUm9vdCAyMDIwMB4XDTIwMDgyNTA3NDgyMFoXDTQ1MDgyNTIz
NTk1OVowYzELMAkGA1UEBhMCREUxJzAlBgNVBAoMHkRldXRzY2hlIFRlbGVrb20gU2VjdXJpdHkg
R21iSDErMCkGA1UEAwwiVGVsZWtvbSBTZWN1cml0eSBUTFMgRUNDIFJvb3QgMjAyMDB2MBAGByqG
SM49AgEGBSuBBAAiA2IABM6//leov9Wq9xCazbzREaK9Z0LMkOsVGJDZos0MKiXrPk/OtdKPD/M1
2kOLAoC+b1EkHQ9rK8qfwm9QMuU3ILYg/4gND21Ju9sGpIeQkpT0CdDPf8iAC8GXs7s1J8nCG6NC
MEAwHQYDVR0OBBYEFONyzG6VmUex5rNhTNHLq+O6zd6fMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0P
AQH/BAQDAgEGMAoGCCqGSM49BAMDA2cAMGQCMHVSi7ekEE+uShCLsoRbQuHmKjYC2qBuGT8lv9pZ
Mo7k+5Dck2TOrbRBR2Diz6fLHgIwN0GMZt9Ba9aDAEH9L1r3ULRn0SyocddDypwnJJGDSA3PzfdU
ga/sf+Rn27iQ7t0l
-----END CERTIFICATE-----

Telekom Security TLS RSA Root 2023
==================================
-----BEGIN CERTIFICATE-----
MIIFszCCA5ugAwIBAgIQIZxULej27HF3+k7ow3BXlzANBgkqhkiG9w0BAQwFADBjMQswCQYDVQQG
EwJERTEnMCUGA1UECgweRGV1dHNjaGUgVGVsZWtvbSBTZWN1cml0eSBHbWJIMSswKQYDVQQDDCJU
ZWxla29tIFNlY3VyaXR5IFRMUyBSU0EgUm9vdCAyMDIzMB4XDTIzMDMyODEyMTY0NVoXDTQ4MDMy
NzIzNTk1OVowYzELMAkGA1UEBhMCREUxJzAlBgNVBAoMHkRldXRzY2hlIFRlbGVrb20gU2VjdXJp
dHkgR21iSDErMCkGA1UEAwwiVGVsZWtvbSBTZWN1cml0eSBUTFMgUlNBIFJvb3QgMjAyMzCCAiIw
DQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAO01oYGA88tKaVvC+1GDrib94W7zgRJ9cUD/h3VC
KSHtgVIs3xLBGYSJwb3FKNXVS2xE1kzbB5ZKVXrKNoIENqil/Cf2SfHVcp6R+SPWcHu79ZvB7JPP
GeplfohwoHP89v+1VmLhc2o0mD6CuKyVU/QBoCcHcqMAU6DksquDOFczJZSfvkgdmOGjup5czQRx
UX11eKvzWarE4GC+j4NSuHUaQTXtvPM6Y+mpFEXX5lLRbtLevOP1Czvm4MS9Q2QTps70mDdsipWo
l8hHD/BeEIvnHRz+sTugBTNoBUGCwQMrAcjnj02r6LX2zWtEtefdi+zqJbQAIldNsLGyMcEWzv/9
FIS3R/qy8XDe24tsNlikfLMR0cN3f1+2JeANxdKz+bi4d9s3cXFH42AYTyS2dTd4uaNir73Jco4v
zLuu2+QVUhkHM/tqty1LkCiCc/4YizWN26cEar7qwU02OxY2kTLvtkCJkUPg8qKrBC7m8kwOFjQg
rIfBLX7JZkcXFBGk8/ehJImr2BrIoVyxo/eMbcgByU/J7MT8rFEz0ciD0cmfHdRHNCk+y7AO+oML
KFjlKdw/fKifybYKu6boRhYPluV75Gp6SG12mAWl3G0eQh5C2hrgUve1g8Aae3g1LDj1H/1Joy7S
WWO/gLCMk3PLNaaZlSJhZQNg+y+TS/qanIA7AgMBAAGjYzBhMA4GA1UdDwEB/wQEAwIBBjAdBgNV
HQ4EFgQUtqeXgj10hZv3PJ+TmpV5dVKMbUcwDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBS2
p5eCPXSFm/c8n5OalXl1UoxtRzANBgkqhkiG9w0BAQwFAAOCAgEAqMxhpr51nhVQpGv7qHBFfLp+
sVr8WyP6Cnf4mHGCDG3gXkaqk/QeoMPhk9tLrbKmXauw1GLLXrtm9S3ul0A8Yute1hTWjOKWi0Fp
kzXmuZlrYrShF2Y0pmtjxrlO8iLpWA1WQdH6DErwM807u20hOq6OcrXDSvvpfeWxm4bu4uB9tPcy
/SKE8YXJN3nptT+/XOR0so8RYgDdGGah2XsjX/GO1WfoVNpbOms2b/mBsTNHM3dA+VKq3dSDz4V4
mZqTuXNnQkYRIer+CqkbGmVps4+uFrb2S1ayLfmlyOw7YqPta9BO1UAJpB+Y1zqlklkg5LB9zVtz
aL1txKITDmcZuI1CfmwMmm6gJC3VRRvcxAIU/oVbZZfKTpBQCHpCNfnqwmbU+AGuHrS+w6jv/naa
oqYfRvaE7fzbzsQCzndILIyy7MMAo+wsVRjBfhnu4S/yrYObnqsZ38aKL4x35bcF7DvB7L6Gs4a8
wPfc5+pbrrLMtTWGS9DiP7bY+A4A7l3j941Y/8+LN+ljX273CXE2whJdV/LItM3z7gLfEdxquVeE
HVlNjM7IDiPCtyaaEBRx/pOyiriA8A4QntOoUAw3gi/q4Iqd4Sw5/7W0cwDk90imc6y/st53BIe0
o82bNSQ3+pCTE4FCxpgmdTdmQRCsu/WU48IxK63nI1bMNSWSs1A=
-----END CERTIFICATE-----

TWCA CYBER Root CA
==================
-----BEGIN CERTIFICATE-----
MIIFjTCCA3WgAwIBAgIQQAE0jMIAAAAAAAAAATzyxjANBgkqhkiG9w0BAQwFADBQMQswCQYDVQQG
EwJUVzESMBAGA1UEChMJVEFJV0FOLUNBMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJUV0NB
IENZQkVSIFJvb3QgQ0EwHhcNMjIxMTIyMDY1NDI5WhcNNDcxMTIyMTU1OTU5WjBQMQswCQYDVQQG
EwJUVzESMBAGA1UEChMJVEFJV0FOLUNBMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJUV0NB
IENZQkVSIFJvb3QgQ0EwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDG+Moe2Qkgfh1s
Ts6P40czRJzHyWmqOlt47nDSkvgEs1JSHWdyKKHfi12VCv7qze33Kc7wb3+szT3vsxxFavcokPFh
V8UMxKNQXd7UtcsZyoC5dc4pztKFIuwCY8xEMCDa6pFbVuYdHNWdZsc/34bKS1PE2Y2yHer43CdT
o0fhYcx9tbD47nORxc5zb87uEB8aBs/pJ2DFTxnk684iJkXXYJndzk834H/nY62wuFm40AZoNWDT
Nq5xQwTxaWV4fPMf88oon1oglWa0zbfuj3ikRRjpJi+NmykosaS3Om251Bw4ckVYsV7r8Cibt4LK
/c/WMw+f+5eesRycnupfXtuq3VTpMCEobY5583WSjCb+3MX2w7DfRFlDo7YDKPYIMKoNM+HvnKkH
IuNZW0CP2oi3aQiotyMuRAlZN1vH4xfyIutuOVLF3lSnmMlLIJXcRolftBL5hSmO68gnFSDAS9TM
fAxsNAwmmyYxpjyn9tnQS6Jk/zuZQXLB4HCX8SS7K8R0IrGsayIyJNN4KsDAoS/xUgXJP+92ZuJF
2A09rZXIx4kmyA+upwMu+8Ff+iDhcK2wZSA3M2Cw1a/XDBzCkHDXShi8fgGwsOsVHkQGzaRP6AzR
wyAQ4VRlnrZR0Bp2a0JaWHY06rc3Ga4udfmW5cFZ95RXKSWNOkyrTZpB0F8mAwIDAQABo2MwYTAO
BgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBSdhWEUfMFib5do5E83
QOGt4A1WNzAdBgNVHQ4EFgQUnYVhFHzBYm+XaORPN0DhreANVjcwDQYJKoZIhvcNAQEMBQADggIB
AGSPesRiDrWIzLjHhg6hShbNcAu3p4ULs3a2D6f/CIsLJc+o1IN1KriWiLb73y0ttGlTITVX1olN
c79pj3CjYcya2x6a4CD4bLubIp1dhDGaLIrdaqHXKGnK/nZVekZn68xDiBaiA9a5F/gZbG0jAn/x
X9AKKSM70aoK7akXJlQKTcKlTfjF/biBzysseKNnTKkHmvPfXvt89YnNdJdhEGoHK4Fa0o635yDR
IG4kqIQnoVesqlVYL9zZyvpoBJ7tRCT5dEA7IzOrg1oYJkK2bVS1FmAwbLGg+LhBoF1JSdJlBTrq
/p1hvIbZv97Tujqxf36SNI7JAG7cmL3c7IAFrQI932XtCwP39xaEBDG6k5TY8hL4iuO/Qq+n1M0R
FxbIQh0UqEL20kCGoE8jypZFVmAGzbdVAaYBlGX+bgUJurSkquLvWL69J1bY73NxW0Qz8ppy6rBe
Pm6pUlvscG21h483XjyMnM7k8M4MZ0HMzvaAq07MTFb1wWFZk7Q+ptq4NxKfKjLji7gh7MMrZQzv
It6IKTtM1/r+t+FHvpw+PoP7UV31aPcuIYXcv/Fa4nzXxeSDwWrruoBa3lwtcHb4yOWHh8qgnaHl
IhInD0Q9HWzq1MKLL295q39QpsQZp6F6t5b5wR9iWqJDB0BeJsas7a5wFsWqynKKTbDPAYsDP27X
-----END CERTIFICATE-----

SecureSign Root CA14
====================
-----BEGIN CERTIFICATE-----
MIIFcjCCA1qgAwIBAgIUZNtaDCBO6Ncpd8hQJ6JaJ90t8sswDQYJKoZIhvcNAQEMBQAwUTELMAkG
A1UEBhMCSlAxIzAhBgNVBAoTGkN5YmVydHJ1c3QgSmFwYW4gQ28uLCBMdGQuMR0wGwYDVQQDExRT
ZWN1cmVTaWduIFJvb3QgQ0ExNDAeFw0yMDA0MDgwNzA2MTlaFw00NTA0MDgwNzA2MTlaMFExCzAJ
BgNVBAYTAkpQMSMwIQYDVQQKExpDeWJlcnRydXN0IEphcGFuIENvLiwgTHRkLjEdMBsGA1UEAxMU
U2VjdXJlU2lnbiBSb290IENBMTQwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDF0nqh
1oq/FjHQmNE6lPxauG4iwWL3pwon71D2LrGeaBLwbCRjOfHw3xDG3rdSINVSW0KZnvOgvlIfX8xn
bacuUKLBl422+JX1sLrcneC+y9/3OPJH9aaakpUqYllQC6KxNedlsmGy6pJxaeQp8E+BgQQ8sqVb
1MWoWWd7VRxJq3qdwudzTe/NCcLEVxLbAQ4jeQkHO6Lo/IrPj8BGJJw4J+CDnRugv3gVEOuGTgpa
/d/aLIJ+7sr2KeH6caH3iGicnPCNvg9JkdjqOvn90Ghx2+m1K06Ckm9mH+Dw3EzsytHqunQG+bOE
kJTRX45zGRBdAuVwpcAQ0BB8b8VYSbSwbprafZX1zNoCr7gsfXmPvkPx+SgojQlD+Ajda8iLLCSx
jVIHvXiby8posqTdDEx5YMaZ0ZPxMBoH064iwurO8YQJzOAUbn8/ftKChazcqRZOhaBgy/ac18iz
ju3Gm5h1DVXoX+WViwKkrkMpKBGk5hIwAUt1ax5mnXkvpXYvHUC0bcl9eQjs0Wq2XSqypWa9a4X0
dFbD9ed1Uigspf9mR6XU/v6eVL9lfgHWMI+lNpyiUBzuOIABSMbHdPTGrMNASRZhdCyvjG817XsY
AFs2PJxQDcqSMxDxJklt33UkN4Ii1+iW/RVLApY+B3KVfqs9TC7XyvDf4Fg/LS8EmjijAQIDAQAB
o0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQUBpOjCl4oaTeq
YR3r6/wtbyPk86AwDQYJKoZIhvcNAQEMBQADggIBAJaAcgkGfpzMkwQWu6A6jZJOtxEaCnFxEM0E
rX+lRVAQZk5KQaID2RFPeje5S+LGjzJmdSX7684/AykmjbgWHfYfM25I5uj4V7Ibed87hwriZLoA
ymzvftAj63iP/2SbNDefNWWipAA9EiOWWF3KY4fGoweITedpdopTzfFP7ELyk+OZpDc8h7hi2/Ds
Hzc/N19DzFGdtfCXwreFamgLRB7lUe6TzktuhsHSDCRZNhqfLJGP4xjblJUK7ZGqDpncllPjYYPG
FrojutzdfhrGe0K22VoF3Jpf1d+42kd92jjbrDnVHmtsKheMYc2xbXIBw8MgAGJoFjHVdqqGuw6q
nsb58Nn4DSEC5MUoFlkRudlpcyqSeLiSV5sI8jrlL5WwWLdrIBRtFO8KvH7YVdiI2i/6GaX7i+B/
OfVyK4XELKzvGUWSTLNhB9xNH27SgRNcmvMSZ4PPmz+Ln52kuaiWA3rF7iDeM9ovnhp6dB7h7sxa
OgTdsxoEqBRjrLdHEoOabPXm6RUVkRqEGQ6UROcSjiVbgGcZ3GOTEAtlLor6CZpO2oYofaphNdgO
pygau1LgePhsumywbrmHXumZNTfxPWQrqaA0k89jL9WB365jJ6UeTo3cKXhZ+PmhIIynJkBugnLN
eLLIjzwec+fBH7/PzqUqm9tEZDKgu39cJRNItX+S
-----END CERTIFICATE-----

SecureSign Root CA15
====================
-----BEGIN CERTIFICATE-----
MIICIzCCAamgAwIBAgIUFhXHw9hJp75pDIqI7fBw+d23PocwCgYIKoZIzj0EAwMwUTELMAkGA1UE
BhMCSlAxIzAhBgNVBAoTGkN5YmVydHJ1c3QgSmFwYW4gQ28uLCBMdGQuMR0wGwYDVQQDExRTZWN1
cmVTaWduIFJvb3QgQ0ExNTAeFw0yMDA0MDgwODMyNTZaFw00NTA0MDgwODMyNTZaMFExCzAJBgNV
BAYTAkpQMSMwIQYDVQQKExpDeWJlcnRydXN0IEphcGFuIENvLiwgTHRkLjEdMBsGA1UEAxMUU2Vj
dXJlU2lnbiBSb290IENBMTUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQLUHSNZDKZmbPSYAi4Io5G
dCx4wCtELW1fHcmuS1Iggz24FG1Th2CeX2yF2wYUleDHKP+dX+Sq8bOLbe1PL0vJSpSRZHX+AezB
2Ot6lHhWGENfa4HL9rzatAy2KZMIaY+jQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQD
AgEGMB0GA1UdDgQWBBTrQciu/NWeUUj1vYv0hyCTQSvT9DAKBggqhkjOPQQDAwNoADBlAjEA2S6J
fl5OpBEHvVnCB96rMjhTKkZEBhd6zlHp4P9mLQlO4E/0BdGF9jVg3PVys0Z9AjBEmEYagoUeYWmJ
SwdLZrWeqrqgHkHZAXQ6bkU6iYAZezKYVWOr62Nuk22rGwlgMU4=
-----END CERTIFICATE-----

D-TRUST BR Root CA 2 2023
=========================
-----BEGIN CERTIFICATE-----
MIIFqTCCA5GgAwIBAgIQczswBEhb2U14LnNLyaHcZjANBgkqhkiG9w0BAQ0FADBIMQswCQYDVQQG
EwJERTEVMBMGA1UEChMMRC1UcnVzdCBHbWJIMSIwIAYDVQQDExlELVRSVVNUIEJSIFJvb3QgQ0Eg
MiAyMDIzMB4XDTIzMDUwOTA4NTYzMVoXDTM4MDUwOTA4NTYzMFowSDELMAkGA1UEBhMCREUxFTAT
BgNVBAoTDEQtVHJ1c3QgR21iSDEiMCAGA1UEAxMZRC1UUlVTVCBCUiBSb290IENBIDIgMjAyMzCC
AiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK7/CVmRgApKaOYkP7in5Mg6CjoWzckjYaCT
cfKri3OPoGdlYNJUa2NRb0kz4HIHE304zQaSBylSa053bATTlfrdTIzZXcFhfUvnKLNEgXtRr90z
sWh81k5M/itoucpmacTsXld/9w3HnDY25QdgrMBM6ghs7wZ8T1soegj8k12b9py0i4a6Ibn08OhZ
WiihNIQaJZG2tY/vsvmA+vk9PBFy2OMvhnbFeSzBqZCTRphny4NqoFAjpzv2gTng7fC5v2Xx2Mt6
++9zA84A9H3X4F07ZrjcjrqDy4d2A/wl2ecjbwb9Z/Pg/4S8R7+1FhhGaRTMBffb00msa8yr5LUL
QyReS2tNZ9/WtT5PeB+UcSTq3nD88ZP+npNa5JRal1QMNXtfbO4AHyTsA7oC9Xb0n9Sa7YUsOCIv
x9gvdhFP/Wxc6PWOJ4d/GUohR5AdeY0cW/jPSoXk7bNbjb7EZChdQcRurDhaTyN0dKkSw/bSuREV
MweR2Ds3OmMwBtHFIjYoYiMQ4EbMl6zWK11kJNXuHA7e+whadSr2Y23OC0K+0bpwHJwh5Q8xaRfX
/Aq03u2AnMuStIv13lmiWAmlY0cL4UEyNEHZmrHZqLAbWt4NDfTisl01gLmB1IRpkQLLddCNxbU9
CZEJjxShFHR5PtbJFR2kWVki3PaKRT08EtY+XTIvAgMBAAGjgY4wgYswDwYDVR0TAQH/BAUwAwEB
/zAdBgNVHQ4EFgQUZ5Dw1t61GNVGKX5cq/ieCLxklRAwDgYDVR0PAQH/BAQDAgEGMEkGA1UdHwRC
MEAwPqA8oDqGOGh0dHA6Ly9jcmwuZC10cnVzdC5uZXQvY3JsL2QtdHJ1c3RfYnJfcm9vdF9jYV8y
XzIwMjMuY3JsMA0GCSqGSIb3DQEBDQUAA4ICAQA097N3U9swFrktpSHxQCF16+tIFoE9c+CeJyrr
d6kTpGoKWloUMz1oH4Guaf2Mn2VsNELZLdB/eBaxOqwjMa1ef67nriv6uvw8l5VAk1/DLQOj7aRv
U9f6QA4w9QAgLABMjDu0ox+2v5Eyq6+SmNMW5tTRVFxDWy6u71cqqLRvpO8NVhTaIasgdp4D/Ca4
nj8+AybmTNudX0KEPUUDAxxZiMrcLmEkWqTqJwtzEr5SswrPMhfiHocaFpVIbVrg0M8JkiZmkdij
YQ6qgYF/6FKC0ULn4B0Y+qSFNueG4A3rvNTJ1jxD8V1Jbn6Bm2m1iWKPiFLY1/4nwSPFyysCu7Ff
/vtDhQNGvl3GyiEm/9cCnnRK3PgTFbGBVzbLZVzRHTF36SXDw7IyN9XxmAnkbWOACKsGkoHU6XCP
pz+y7YaMgmo1yEJagtFSGkUPFaUA8JR7ZSdXOUPPfH/mvTWze/EZTN46ls/pdu4D58JDUjxqgejB
WoC9EV2Ta/vH5mQ/u2kc6d0li690yVRAysuTEwrt+2aSEcr1wPrYg1UDfNPFIkZ1cGt5SAYqgpq/
5usWDiJFAbzdNpQ0qTUmiteXue4Icr80knCDgKs4qllo3UCkGJCy89UDyibK79XH4I9TjvAA46jt
n/mtd+ArY0+ew+43u3gJhJ65bvspmZDogNOfJA==
-----END CERTIFICATE-----

TrustAsia TLS ECC Root CA
=========================
-----BEGIN CERTIFICATE-----
MIICMTCCAbegAwIBAgIUNnThTXxlE8msg1UloD5Sfi9QaMcwCgYIKoZIzj0EAwMwWDELMAkGA1UE
BhMCQ04xJTAjBgNVBAoTHFRydXN0QXNpYSBUZWNobm9sb2dpZXMsIEluYy4xIjAgBgNVBAMTGVRy
dXN0QXNpYSBUTFMgRUNDIFJvb3QgQ0EwHhcNMjQwNTE1MDU0MTU2WhcNNDQwNTE1MDU0MTU1WjBY
MQswCQYDVQQGEwJDTjElMCMGA1UEChMcVHJ1c3RBc2lhIFRlY2hub2xvZ2llcywgSW5jLjEiMCAG
A1UEAxMZVHJ1c3RBc2lhIFRMUyBFQ0MgUm9vdCBDQTB2MBAGByqGSM49AgEGBSuBBAAiA2IABLh/
pVs/AT598IhtrimY4ZtcU5nb9wj/1WrgjstEpvDBjL1P1M7UiFPoXlfXTr4sP/MSpwDpguMqWzJ8
S5sUKZ74LYO1644xST0mYekdcouJtgq7nDM1D9rs3qlKH8kzsaNCMEAwDwYDVR0TAQH/BAUwAwEB
/zAdBgNVHQ4EFgQULIVTu7FDzTLqnqOH/qKYqKaT6RAwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49
BAMDA2gAMGUCMFRH18MtYYZI9HlaVQ01L18N9mdsd0AaRuf4aFtOJx24mH1/k78ITcTaRTChD15K
eAIxAKORh/IRM4PDwYqROkwrULG9IpRdNYlzg8WbGf60oenUoWa2AaU2+dhoYSi3dOGiMQ==
-----END CERTIFICATE-----

TrustAsia TLS RSA Root CA
=========================
-----BEGIN CERTIFICATE-----
MIIFgDCCA2igAwIBAgIUHBjYz+VTPyI1RlNUJDxsR9FcSpwwDQYJKoZIhvcNAQEMBQAwWDELMAkG
A1UEBhMCQ04xJTAjBgNVBAoTHFRydXN0QXNpYSBUZWNobm9sb2dpZXMsIEluYy4xIjAgBgNVBAMT
GVRydXN0QXNpYSBUTFMgUlNBIFJvb3QgQ0EwHhcNMjQwNTE1MDU0MTU3WhcNNDQwNTE1MDU0MTU2
WjBYMQswCQYDVQQGEwJDTjElMCMGA1UEChMcVHJ1c3RBc2lhIFRlY2hub2xvZ2llcywgSW5jLjEi
MCAGA1UEAxMZVHJ1c3RBc2lhIFRMUyBSU0EgUm9vdCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIP
ADCCAgoCggIBAMMWuBtqpERz5dZO9LnPWwvB0ZqB9WOwj0PBuwhaGnrhB3YmH49pVr7+NmDQDIPN
lOrnxS1cLwUWAp4KqC/lYCZUlviYQB2srp10Zy9U+5RjmOMmSoPGlbYJQ1DNDX3eRA5gEk9bNb2/
mThtfWza4mhzH/kxpRkQcwUqwzIZheo0qt1CHjCNP561HmHVb70AcnKtEj+qpklz8oYVlQwQX1Fk
zv93uMltrOXVmPGZLmzjyUT5tUMnCE32ft5EebuyjBza00tsLtbDeLdM1aTk2tyKjg7/D8OmYCYo
zza/+lcK7Fs/6TAWe8TbxNRkoDD75f0dcZLdKY9BWN4ArTr9PXwaqLEX8E40eFgl1oUh63kd0Nyr
z2I8sMeXi9bQn9P+PN7F4/w6g3CEIR0JwqH8uyghZVNgepBtljhb//HXeltt08lwSUq6HTrQUNoy
IBnkiz/r1RYmNzz7dZ6wB3C4FGB33PYPXFIKvF1tjVEK2sUYyJtt3LCDs3+jTnhMmCWr8n4uIF6C
FabW2I+s5c0yhsj55NqJ4js+k8UTav/H9xj8Z7XvGCxUq0DTbE3txci3OE9kxJRMT6DNrqXGJyV1
J23G2pyOsAWZ1SgRxSHUuPzHlqtKZFlhaxP8S8ySpg+kUb8OWJDZgoM5pl+z+m6Ss80zDoWo8SnT
q1mt1tve1CuBAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFLgHkXlcBvRG/XtZ
ylomkadFK/hTMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQwFAAOCAgEAIZtqBSBdGBanEqT3
Rz/NyjuujsCCztxIJXgXbODgcMTWltnZ9r96nBO7U5WS/8+S4PPFJzVXqDuiGev4iqME3mmL5Dw8
veWv0BIb5Ylrc5tvJQJLkIKvQMKtuppgJFqBTQUYo+IzeXoLH5Pt7DlK9RME7I10nYEKqG/odv6L
TytpEoYKNDbdgptvT+Bz3Ul/KD7JO6NXBNiT2Twp2xIQaOHEibgGIOcberyxk2GaGUARtWqFVwHx
tlotJnMnlvm5P1vQiJ3koP26TpUJg3933FEFlJ0gcXax7PqJtZwuhfG5WyRasQmr2soaB82G39tp
27RIGAAtvKLEiUUjpQ7hRGU+isFqMB3iYPg6qocJQrmBktwliJiJ8Xw18WLK7nn4GS/+X/jbh87q
qA8MpugLoDzga5SYnH+tBuYc6kIQX+ImFTw3OffXvO645e8D7r0i+yiGNFjEWn9hongPXvPKnbwb
PKfILfanIhHKA9jnZwqKDss1jjQ52MjqjZ9k4DewbNfFj8GQYSbbJIweSsCI3zWQzj8C9GRh3sfI
B5XeMhg6j6JCQCTl1jNdfK7vsU1P1FeQNWrcrgSXSYk0ly4wBOeY99sLAZDBHwo/+ML+TvrbmnNz
FrwFuHnYWa8G5z9nODmxfKuU4CkUpijy323imttUQ/hHWKNddBWcwauwxzQ=
-----END CERTIFICATE-----

D-TRUST EV Root CA 2 2023
=========================
-----BEGIN CERTIFICATE-----
MIIFqTCCA5GgAwIBAgIQaSYJfoBLTKCnjHhiU19abzANBgkqhkiG9w0BAQ0FADBIMQswCQYDVQQG
EwJERTEVMBMGA1UEChMMRC1UcnVzdCBHbWJIMSIwIAYDVQQDExlELVRSVVNUIEVWIFJvb3QgQ0Eg
MiAyMDIzMB4XDTIzMDUwOTA5MTAzM1oXDTM4MDUwOTA5MTAzMlowSDELMAkGA1UEBhMCREUxFTAT
BgNVBAoTDEQtVHJ1c3QgR21iSDEiMCAGA1UEAxMZRC1UUlVTVCBFViBSb290IENBIDIgMjAyMzCC
AiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANiOo4mAC7JXUtypU0w3uX9jFxPvp1sjW2l1
sJkKF8GLxNuo4MwxusLyzV3pt/gdr2rElYfXR8mV2IIEUD2BCP/kPbOx1sWy/YgJ25yE7CUXFId/
MHibaljJtnMoPDT3mfd/06b4HEV8rSyMlD/YZxBTfiLNTiVR8CUkNRFeEMbsh2aJgWi6zCudR3Mf
vc2RpHJqnKIbGKBv7FD0fUDCqDDPvXPIEysQEx6Lmqg6lHPTGGkKSv/BAQP/eX+1SH977ugpbzZM
lWGG2Pmic4ruri+W7mjNPU0oQvlFKzIbRlUWaqZLKfm7lVa/Rh3sHZMdwGWyH6FDrlaeoLGPaxK3
YG14C8qKXO0elg6DpkiVjTujIcSuWMYAsoS0I6SWhjW42J7YrDRJmGOVxcttSEfi8i4YHtAxq910
7PncjLgcjmgjutDzUNzPZY9zOjLHfP7KgiJPvo5iR2blzYfi6NUPGJ/lBHJLRjwQ8kTCZFZxTnXo
nMkmdMV9WdEKWw9t/p51HBjGGjp82A0EzM23RWV6sY+4roRIPrN6TagD4uJ+ARZZaBhDM7DS3LAa
QzXupdqpRlyuhoFBAUp0JuyfBr/CBTdkdXgpaP3F9ev+R/nkhbDhezGdpn9yo7nELC7MmVcOIQxF
AZRl62UJxmMiCzNJkkg8/M3OsD6Onov4/knFNXJHAgMBAAGjgY4wgYswDwYDVR0TAQH/BAUwAwEB
/zAdBgNVHQ4EFgQUqvyREBuHkV8Wub9PS5FeAByxMoAwDgYDVR0PAQH/BAQDAgEGMEkGA1UdHwRC
MEAwPqA8oDqGOGh0dHA6Ly9jcmwuZC10cnVzdC5uZXQvY3JsL2QtdHJ1c3RfZXZfcm9vdF9jYV8y
XzIwMjMuY3JsMA0GCSqGSIb3DQEBDQUAA4ICAQCTy6UfmRHsmg1fLBWTxj++EI14QvBukEdHjqOS
Mo1wj/Zbjb6JzkcBahsgIIlbyIIQbODnmaprxiqgYzWRaoUlrRc4pZt+UPJ26oUFKidBK7GB0aL2
QHWpDsvxVUjY7NHss+jOFKE17MJeNRqrphYBBo7q3C+jisosketSjl8MmxfPy3MHGcRqwnNU73xD
UmPBEcrCRbH0O1P1aa4846XerOhUt7KR/aypH/KH5BfGSah82ApB9PI+53c0BFLd6IHyTS9URZ0V
4U/M5d40VxDJI3IXcI1QcB9WbMy5/zpaT2N6w25lBx2Eof+pDGOJbbJAiDnXH3dotfyc1dZnaVuo
dNv8ifYbMvekJKZ2t0dT741Jj6m2g1qllpBFYfXeA08mD6iL8AOWsKwV0HFaanuU5nCT2vFp4LJi
TZ6P/4mdm13NRemUAiKN4DV/6PEEeXFsVIP4M7kFMhtYVRFP0OUnR3Hs7dpn1mKmS00PaaLJvOwi
S5THaJQXfuKOKD62xur1NGyfN4gHONuGcfrNlUhDbqNPgofXNJhuS5N5YHVpD/Aa1VP6IQzCP+k/
HxiMkl14p3ZnGbuy6n/pcAlWVqOwDAstNl7F6cTVg8uGF5csbBNvh1qvSaYd2804BC5f4ko1Di1L
+KIkBI3Y4WNeApI02phhXBxvWHZks/wCuPWdCg==
-----END CERTIFICATE-----

SwissSign RSA TLS Root CA 2022 - 1
==================================
-----BEGIN CERTIFICATE-----
MIIFkzCCA3ugAwIBAgIUQ/oMX04bgBhE79G0TzUfRPSA7cswDQYJKoZIhvcNAQELBQAwUTELMAkG
A1UEBhMCQ0gxFTATBgNVBAoTDFN3aXNzU2lnbiBBRzErMCkGA1UEAxMiU3dpc3NTaWduIFJTQSBU
TFMgUm9vdCBDQSAyMDIyIC0gMTAeFw0yMjA2MDgxMTA4MjJaFw00NzA2MDgxMTA4MjJaMFExCzAJ
BgNVBAYTAkNIMRUwEwYDVQQKEwxTd2lzc1NpZ24gQUcxKzApBgNVBAMTIlN3aXNzU2lnbiBSU0Eg
VExTIFJvb3QgQ0EgMjAyMiAtIDEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDLKmji
C8NXvDVjvHClO/OMPE5Xlm7DTjak9gLKHqquuN6orx122ro10JFwB9+zBvKK8i5VUXu7LCTLf5Im
gKO0lPaCoaTo+nUdWfMHamFk4saMla+ju45vVs9xzF6BYQ1t8qsCLqSX5XH8irCRIFucdFJtrhUn
WXjyCcplDn/L9Ovn3KlMd/YrFgSVrpxxpT8q2kFC5zyEEPThPYxr4iuRR1VPuFa+Rd4iUU1OKNlf
GUEGjw5NBuBwQCMBauTLE5tzrE0USJIt/m2n+IdreXXhvhCxqohAWVTXz8TQm0SzOGlkjIHRI36q
OTw7D59Ke4LKa2/KIj4x0LDQKhySio/YGZxH5D4MucLNvkEM+KRHBdvBFzA4OmnczcNpI/2aDwLO
EGrOyvi5KaM2iYauC8BPY7kGWUleDsFpswrzd34unYyzJ5jSmY0lpx+Gs6ZUcDj8fV3oT4MM0ZPl
EuRU2j7yrTrePjxF8CgPBrnh25d7mUWe3f6VWQQvdT/TromZhqwUtKiE+shdOxtYk8EXlFXIC+OC
eYSf8wCENO7cMdWP8vpPlkwGqnj73mSiI80fPsWMvDdUDrtaclXvyFu1cvh43zcgTFeRc5JzrBh3
Q4IgaezprClG5QtO+DdziZaKHG29777YtvTKwP1H8K4LWCDFyB02rpeNUIMmJCn3nTsPBQIDAQAB
o2MwYTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAfBgNVHSMEGDAWgBRvjmKLk0Ow
4UD2p8P98Q+4DxU4pTAdBgNVHQ4EFgQUb45ii5NDsOFA9qfD/fEPuA8VOKUwDQYJKoZIhvcNAQEL
BQADggIBAKwsKUF9+lz1GpUYvyypiqkkVHX1uECry6gkUSsYP2OprphWKwVDIqO310aewCoSPY6W
lkDfDDOLazeROpW7OSltwAJsipQLBwJNGD77+3v1dj2b9l4wBlgzHqp41eZUBDqyggmNzhYzWUUo
8aWjlw5DI/0LIICQ/+Mmz7hkkeUFjxOgdg3XNwwQiJb0Pr6VvfHDffCjw3lHC1ySFWPtUnWK50Zp
y1FVCypM9fJkT6lc/2cyjlUtMoIcgC9qkfjLvH4YoiaoLqNTKIftV+Vlek4ASltOU8liNr3Cjlvr
zG4ngRhZi0Rjn9UMZfQpZX+RLOV/fuiJz48gy20HQhFRJjKKLjpHE7iNvUcNCfAWpO2Whi4Z2L6M
OuhFLhG6rlrnub+xzI/goP+4s9GFe3lmozm1O2bYQL7Pt2eLSMkZJVX8vY3PXtpOpvJpzv1/THfQ
wUY1mFwjmwJFQ5Ra3bxHrSL+ul4vkSkphnsh3m5kt8sNjzdbowhq6/TdAo9QAwKxuDdollDruF/U
KIqlIgyKhPBZLtU30WHlQnNYKoH3dtvi4k0NX/a3vgW0rk4N3hY9A4GzJl5LuEsAz/+MF7psYC0n
hzck5npgL7XTgwSqT0N1osGDsieYK7EOgLrAhV5Cud+xYJHT6xh+cHiudoO+cVrQkOPKwRYlZ0rw
tnu64ZzZ
-----END CERTIFICATE-----

OISTE Server Root ECC G1
========================
-----BEGIN CERTIFICATE-----
MIICNTCCAbqgAwIBAgIQI/nD1jWvjyhLH/BU6n6XnTAKBggqhkjOPQQDAzBLMQswCQYDVQQGEwJD
SDEZMBcGA1UECgwQT0lTVEUgRm91bmRhdGlvbjEhMB8GA1UEAwwYT0lTVEUgU2VydmVyIFJvb3Qg
RUNDIEcxMB4XDTIzMDUzMTE0NDIyOFoXDTQ4MDUyNDE0NDIyN1owSzELMAkGA1UEBhMCQ0gxGTAX
BgNVBAoMEE9JU1RFIEZvdW5kYXRpb24xITAfBgNVBAMMGE9JU1RFIFNlcnZlciBSb290IEVDQyBH
MTB2MBAGByqGSM49AgEGBSuBBAAiA2IABBcv+hK8rBjzCvRE1nZCnrPoH7d5qVi2+GXROiFPqOuj
vqQycvO2Ackr/XeFblPdreqqLiWStukhEaivtUwL85Zgmjvn6hp4LrQ95SjeHIC6XG4N2xml4z+c
KrhAS93mT6NjMGEwDwYDVR0TAQH/BAUwAwEB/zAfBgNVHSMEGDAWgBQ3TYhlz/w9itWj8UnATgwQ
b0K0nDAdBgNVHQ4EFgQUN02IZc/8PYrVo/FJwE4MEG9CtJwwDgYDVR0PAQH/BAQDAgGGMAoGCCqG
SM49BAMDA2kAMGYCMQCpKjAd0MKfkFFRQD6VVCHNFmb3U2wIFjnQEnx/Yxvf4zgAOdktUyBFCxxg
ZzFDJe0CMQCSia7pXGKDYmH5LVerVrkR3SW+ak5KGoJr3M/TvEqzPNcum9v4KGm8ay3sMaE641c=
-----END CERTIFICATE-----

OISTE Server Root RSA G1
========================
-----BEGIN CERTIFICATE-----
MIIFgzCCA2ugAwIBAgIQVaXZZ5Qoxu0M+ifdWwFNGDANBgkqhkiG9w0BAQwFADBLMQswCQYDVQQG
EwJDSDEZMBcGA1UECgwQT0lTVEUgRm91bmRhdGlvbjEhMB8GA1UEAwwYT0lTVEUgU2VydmVyIFJv
b3QgUlNBIEcxMB4XDTIzMDUzMTE0MzcxNloXDTQ4MDUyNDE0MzcxNVowSzELMAkGA1UEBhMCQ0gx
GTAXBgNVBAoMEE9JU1RFIEZvdW5kYXRpb24xITAfBgNVBAMMGE9JU1RFIFNlcnZlciBSb290IFJT
QSBHMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAKqu9KuCz/vlNwvn1ZatkOhLKdxV
YOPMvLO8LZK55KN68YG0nnJyQ98/qwsmtO57Gmn7KNByXEptaZnwYx4M0rH/1ow00O7brEi56rAU
jtgHqSSY3ekJvqgiG1k50SeH3BzN+Puz6+mTeO0Pzjd8JnduodgsIUzkik/HEzxux9UTl7Ko2yRp
g1bTacuCErudG/L4NPKYKyqOBGf244ehHa1uzjZ0Dl4zO8vbUZeUapU8zhhabkvG/AePLhq5Svdk
NCncpo1Q4Y2LS+VIG24ugBA/5J8bZT8RtOpXaZ+0AOuFJJkk9SGdl6r7NH8CaxWQrbueWhl/pIzY
+m0o/DjH40ytas7ZTpOSjswMZ78LS5bOZmdTaMsXEY5Z96ycG7mOaES3GK/m5Q9l3JUJsJMStR8+
lKXHiHUhsd4JJCpM4rzsTGdHwimIuQq6+cF0zowYJmXa92/GjHtoXAvuY8BeS/FOzJ8vD+HomnqT
8eDI278n5mUpezbgMxVz8p1rhAhoKzYHKyfMeNhqhw5HdPSqoBNdZH702xSu+zrkL8Fl47l6QGzw
Brd7KJvX4V84c5Ss2XCTLdyEr0YconosP4EmQufU2MVshGYRi3drVByjtdgQ8K4p92cIiBdcuJd5
z+orKu5YM+Vt6SmqZQENghPsJQtdLEByFSnTkCz3GkPVavBpAgMBAAGjYzBhMA8GA1UdEwEB/wQF
MAMBAf8wHwYDVR0jBBgwFoAU8snBDw1jALvsRQ5KH7WxszbNDo0wHQYDVR0OBBYEFPLJwQ8NYwC7
7EUOSh+1sbM2zQ6NMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQwFAAOCAgEANGd5sjrG5T33
I3K5Ce+SrScfoE4KsvXaFwyihdJ+klH9FWXXXGtkFu6KRcoMQzZENdl//nk6HOjG5D1rd9QhEOP2
8yBOqb6J8xycqd+8MDoX0TJD0KqKchxRKEzdNsjkLWd9kYccnbz8qyiWXmFcuCIzGEgWUOrKL+ml
Sdx/PKQZvDatkuK59EvV6wit53j+F8Bdh3foZ3dPAGav9LEDOr4SfEE15fSmG0eLy3n31r8Xbk5l
8PjaV8GUgeV6Vg27Rn9vkf195hfkgSe7BYhW3SCl95gtkRlpMV+bMPKZrXJAlszYd2abtNUOshD+
FKrDgHGdPY3ofRRsYWSGRqbXVMW215AWRqWFyp464+YTFrYVI8ypKVL9AMb2kI5Wj4kI3Zaq5tNq
qYY19tVFeEJKRvwDyF7YZvZFZSS0vod7VSCd9521Kvy5YhnLbDuv0204bKt7ph6N/Ome/msVuduC
msuY33OhkKCgxeDoAaijFJzIwZqsFVAzje18KotzlUBDJvyBpCpfOZC3J8tRd/iWkx7P8nd9H0aT
olkelUTFLXVksNb54Dxp6gS1HAviRkRNQzuXSXERvSS2wq1yVAb+axj5d9spLFKebXd7Yv0PTY6Y
MjAwcRLWJTXjn/hvnLXrahut6hDTlhZyBiElxky8j3C7DOReIoMt0r7+hVu05L0=
-----END CERTIFICATE-----

e-Szigno TLS Root CA 2023
=========================
-----BEGIN CERTIFICATE-----
MIICzzCCAjGgAwIBAgINAOhvGHvWOWuYSkmYCjAKBggqhkjOPQQDBDB1MQswCQYDVQQGEwJIVTER
MA8GA1UEBwwIQnVkYXBlc3QxFjAUBgNVBAoMDU1pY3Jvc2VjIEx0ZC4xFzAVBgNVBGEMDlZBVEhV
LTIzNTg0NDk3MSIwIAYDVQQDDBllLVN6aWdubyBUTFMgUm9vdCBDQSAyMDIzMB4XDTIzMDcxNzE0
MDAwMFoXDTM4MDcxNzE0MDAwMFowdTELMAkGA1UEBhMCSFUxETAPBgNVBAcMCEJ1ZGFwZXN0MRYw
FAYDVQQKDA1NaWNyb3NlYyBMdGQuMRcwFQYDVQRhDA5WQVRIVS0yMzU4NDQ5NzEiMCAGA1UEAwwZ
ZS1Temlnbm8gVExTIFJvb3QgQ0EgMjAyMzCBmzAQBgcqhkjOPQIBBgUrgQQAIwOBhgAEAGgP36J8
PKp0iGEKjcJMpQEiFNT3YHdCnAo4YKGMZz6zY+n6kbCLS+Y53wLCMAFSAL/fjO1ZrTJlqwlZULUZ
wmgcAOAFX9pQJhzDrAQixTpN7+lXWDajwRlTEArRzT/vSzUaQ49CE0y5LBqcvjC2xN7cS53kpDzL
Ltmt3999Cd8ukv+ho2MwYTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4E
FgQUWYQCYlpGePVd3I8KECgj3NXW+0UwHwYDVR0jBBgwFoAUWYQCYlpGePVd3I8KECgj3NXW+0Uw
CgYIKoZIzj0EAwQDgYsAMIGHAkIBLdqu9S54tma4n7Zwf2Z0z+yOfP7AAXmazlIC58PRDHpty7Ve
7hekm9sEdu4pKeiv+62sUvTXK9Z3hBC9xdIoaDQCQTV2WnXzkoYI9bIeCvZlC9p2x1L/Cx6AcCIw
wzPbGO2E14vs7dOoY4G1VnxHx1YwlGhza9IuqbnZLBwpvQy6uWWL
-----END CERTIFICATE-----
LUMEN_CA_BUNDLE;
}
