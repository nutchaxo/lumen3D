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

// ── HTTPS client (curl preferred, stream fallback; https-only, max 5 redirects) ──

function https_only(string $url): bool { return strncasecmp($url, 'https://', 8) === 0; }

function http_capable(): bool {
    return extension_loaded('curl') || filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN);
}

/**
 * Small HTTPS GET for API JSON / checksum files (body buffered in memory).
 * Returns ['ok'=>bool,'status'=>int,'headers'=>array<lower,string>,'body'=>string,'error'=>?string].
 */
function http_get_small(string $url, array $extraHeaders = []): array {
    if (!https_only($url)) return ['ok' => false, 'status' => 0, 'headers' => [], 'body' => '', 'error' => 'not_https'];
    $headers = array_merge(['User-Agent: ' . INSTALLER_UA, 'Accept: */*'], $extraHeaders);

    if (extension_loaded('curl')) {
        $respHeaders = [];
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => MAX_REDIRECTS,
            CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) {
                if (stripos($line, 'HTTP/') === 0) { $respHeaders = []; }                 // new hop → reset
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

    // Stream fallback with a manual https-only redirect loop.
    $redirects = 0;
    while (true) {
        if (!https_only($url)) return ['ok' => false, 'status' => 0, 'headers' => [], 'body' => '', 'error' => 'redirect_not_https'];
        $ctx = stream_context_create([
            'http' => ['method' => 'GET', 'header' => implode("\r\n", $headers),
                       'follow_location' => 0, 'timeout' => 30, 'ignore_errors' => true],
            'ssl'  => ['verify_peer' => true, 'verify_peer_name' => true],
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
        $res = curl_download_tick($url, $fp, $offset, $rangeEnd, $expectedTotal);
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
function curl_download_tick(string $url, $fp, int $offset, int $rangeEnd, ?int $expectedTotal): array {
    $ctx = [
        'fp' => $fp, 'written' => 0, 'cap' => TICK_BYTES, 'deadline' => microtime(true) + TICK_SECONDS,
        'status' => 0, 'total' => null, 'bodyStarted' => false, 'capped' => false,
        'diskError' => false, 'httpError' => 0, 'noRange' => false, 'restarted' => false, 'offset' => $offset,
    ];
    $ch = curl_init($url);
    curl_setopt_array($ch, [
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
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
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
    if (!$r['ok']) return ['ok' => false, 'error' => 'github_unreachable', 'retryAfterMin' => null, 'release' => null, 'detail' => $r['error'] ?? ('http_' . $r['status'])];

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
    return [
        ['id' => 'php',      'ok' => PHP_VERSION_ID >= 70400, 'value' => PHP_VERSION],
        ['id' => 'zip',      'ok' => class_exists('ZipArchive'), 'value' => class_exists('ZipArchive') ? 'ZipArchive' : null],
        ['id' => 'http',     'ok' => http_capable(), 'value' => extension_loaded('curl') ? 'curl' : (http_capable() ? 'allow_url_fopen' : null)],
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
    $ignore = ['.', '..', 'install.php', STATE_FILE, LOCK_FILE, PART_FILE, ZIP_FILE, STATE_FILE . '.tmp'];
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
        if (!is_dir($dest) && !@mkdir($dest, 0755, true) && !is_dir($dest)) throw new RuntimeException('mkdir_failed');
        if (!within_target($dest)) throw new RuntimeException('zip_bad_entry:escape');
        return 0;
    }

    $dir = dirname($dest);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir)) throw new RuntimeException('mkdir_failed');
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
    if (!is_dir($apiDir) && !@mkdir($apiDir, 0755, true) && !is_dir($apiDir)) json_fail('mkdir_failed', 500);

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
    }

    // Data layout (only create what is absent — never touch existing data).
    foreach (['DATA_WEB', 'DATA_WEB/fixed', 'DATA_WEB/live', 'DATA_WEB/tracking'] as $d) {
        $p = tpath($d);
        if (!is_dir($p) && !@mkdir($p, 0755, true) && !is_dir($p)) json_fail('mkdir_failed', 500);
    }
    $catalog = tpath('DATA_WEB/catalog.json');
    if (!file_exists($catalog)) {
        if (file_put_contents($catalog, json_encode(['datasets' => []])) === false) json_fail('catalog_write_failed', 500);
    }

    $s['phase'] = 'configured';
    if (!write_state($s)) json_fail('state_write_failed', 500);
    json_out(['ok' => true]);
}

/** Write .install-lock, remove installer working files. */
function handle_finalize(): void {
    $s = require_state(['configured']);
    $lock = json_encode(['installedAt' => date('c'), 'version' => $s['release']['version'] ?? null]);
    if (file_put_contents(tpath(LOCK_FILE), $lock) === false) json_fail('lock_write_failed', 500);
    clear_artifacts(true);
    $leftover = is_file(tpath(STATE_FILE));
    json_out(['ok' => true, 'stateCleared' => !$leftover]);
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
  crypto: ['req_crypto', 'hint_crypto'], writable: ['req_writable', 'hint_writable'], disk: ['req_disk', 'hint_disk']
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
      r.ok === false && hintKey ? el('span', { class: 'req-hint', text: t(hintKey) }) : null
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
