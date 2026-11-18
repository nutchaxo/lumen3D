<?php
/**
 * Stale-code probe: explains why the PHP code that EXECUTES is older than the files
 * of the release, and drops what it can.
 *
 * Self-contained on purpose. The case it exists for is a host whose api/_admin_lib.php
 * is an OLD library (not replaced on disk, or served from a stale opcache copy), so
 * nothing here may call an admin_* / mkt_* / lumen_* function of another file. Only
 * functions are defined: requesting this file over HTTP does nothing.
 *
 * Facts it reports (see lumen_probe_diagnose): the version stamped in the library's
 * BYTES on disk, which shipped files differ from api/code-manifest.json (written by
 * tools/build_release.py), whether PHP may write each of them, and what opcache does.
 */
declare(strict_types=1);

if (!function_exists('lumen_probe_tuple')) {
    /** "1.84.2" → [1,84,2]; anything else → [0,0,0] (compared as integers, never as strings). */
    function lumen_probe_tuple(?string $v): array {
        if ($v === null || preg_match('/^(\d+)\.(\d+)\.(\d+)$/D', $v, $m) !== 1) return [0, 0, 0];
        return [(int)$m[1], (int)$m[2], (int)$m[3]];
    }
}

if (!function_exists('lumen_probe_stamp')) {
    /** The version stamped in a library's source (const LUMEN_CODE_VERSION = 'X.Y.Z'),
     *  null when absent or still the checkout placeholder. */
    function lumen_probe_stamp(string $bytes): ?string {
        if (preg_match("/const\\s+LUMEN_CODE_VERSION\\s*=\\s*'(\\d+\\.\\d+\\.\\d+)'/", $bytes, $m) === 1) return $m[1];
        return null;
    }
}

if (!function_exists('lumen_probe_owner_name')) {
    function lumen_probe_owner_name($id, bool $group): ?string {
        if ($id === false || $id === null) return null;
        if ($group && function_exists('posix_getgrgid')) {
            $g = @posix_getgrgid((int)$id);
            if (is_array($g) && isset($g['name'])) return (string)$g['name'];
        } elseif (!$group && function_exists('posix_getpwuid')) {
            $p = @posix_getpwuid((int)$id);
            if (is_array($p) && isset($p['name'])) return (string)$p['name'];
        }
        return (string)$id;
    }
}

if (!function_exists('lumen_probe_php_user')) {
    function lumen_probe_php_user(): ?string {
        if (function_exists('posix_geteuid')) return lumen_probe_owner_name(@posix_geteuid(), false);
        $u = function_exists('get_current_user') ? @get_current_user() : '';
        return is_string($u) && $u !== '' ? $u : null;
    }
}

if (!function_exists('lumen_probe_file_facts')) {
    /** What the operator (or the host's support) needs to know about one file. */
    function lumen_probe_file_facts(string $root, string $rel): array {
        $path = $root . '/' . $rel;
        $exists = @is_file($path);
        $perms = $exists && function_exists('fileperms') ? @fileperms($path) : false;
        $uid = $exists && function_exists('fileowner') ? @fileowner($path) : false;
        $gid = $exists && function_exists('filegroup') ? @filegroup($path) : false;
        $me = function_exists('posix_geteuid') ? @posix_geteuid() : null;
        $writable = $exists && function_exists('is_writable') && @is_writable($path);
        $dirWritable = function_exists('is_writable') && @is_writable(dirname($path));
        return [
            'path' => $rel,
            'exists' => $exists,
            'writable' => $writable,
            'dirWritable' => $dirWritable,
            // The updater replaces a file by rename when its folder is writable, whoever owns the file.
            'replaceable' => $writable || $dirWritable,
            'owner' => lumen_probe_owner_name($uid, false),
            'group' => lumen_probe_owner_name($gid, true),
            'perms' => $perms === false ? null : sprintf('%04o', $perms & 0777),
            'phpOwns' => ($uid === false || $me === null) ? null : ((int)$uid === (int)$me),
        ];
    }
}

if (!function_exists('lumen_probe_opcache')) {
    /** Same shape and semantics as admin_opcache_report (copied: the library may be old). */
    function lumen_probe_opcache(): array {
        $ini = function (string $k) { return function_exists('ini_get') ? @ini_get($k) : false; };
        $available = function_exists('opcache_get_status') || function_exists('opcache_invalidate');
        $iniEnabled = $ini('opcache.enable');
        $restrict = $ini('opcache.restrict_api');
        $validate = $ini('opcache.validate_timestamps');
        $freq = $ini('opcache.revalidate_freq');
        $status = function_exists('opcache_get_status') ? @opcache_get_status(false) : false;
        return [
            'available' => $available,
            'enabled' => $status !== false && $status !== null ? (bool)($status['opcache_enabled'] ?? false)
                         : ($iniEnabled !== false && $iniEnabled !== '' && $iniEnabled !== '0'),
            'statusReadable' => is_array($status),
            'restrictApi' => is_string($restrict) ? $restrict : '',
            'validateTimestamps' => ($validate === false || $validate === '') ? null : ($validate !== '0'),
            'revalidateFreq' => is_string($freq) && $freq !== '' ? (int)$freq : null,
        ];
    }
}

if (!function_exists('lumen_probe_served_files')) {
    /** api/*.php and the root *.php: everything PHP compiles for a request. */
    function lumen_probe_served_files(string $root): array {
        $out = [];
        if (!function_exists('glob')) return $out;
        foreach ([$root . '/api/*.php', $root . '/*.php'] as $pattern) {
            foreach ((array)@glob($pattern) as $f) if (is_string($f) && @is_file($f)) $out[] = $f;
        }
        return $out;
    }
}

if (!function_exists('lumen_probe_recover')) {
    /** Drop this PHP process's compiled copy of every served file. Not throttled: it is
     *  cheap, only reached in the stale state, and per process/node (a throttle shared
     *  over NFS would make a second node skip its own invalidation). No opcache_reset. */
    function lumen_probe_recover(string $root, array $opcache): array {
        $files = lumen_probe_served_files($root);
        $tried = 0;
        $invalidated = 0;
        if (function_exists('opcache_invalidate')) {
            foreach ($files as $f) {
                $tried++;
                if (@opcache_invalidate($f, true)) $invalidated++;
            }
        }
        $blocked = !empty($opcache['enabled'])
            && (!function_exists('opcache_invalidate') || ($tried > 0 && $invalidated === 0));
        return ['invalidated' => $invalidated, 'tried' => $tried, 'blocked' => $blocked];
    }
}

if (!function_exists('lumen_probe_touch')) {
    /**
     * Give the served PHP files that are RIGHT the modification time of now.
     *
     * opcache with validate_timestamps=1 recompiles a file only when its mtime differs
     * from the one it compiled, and it may forbid opcache_invalidate (restrict_api).
     * ZipArchive::extractTo (PHP >= 8.0) restores the archive's entry dates, and
     * releases built before 1.84.3 gave every entry the same date: the new bytes then
     * carried the old mtime and the old bytecode stayed in use for good. A fresh mtime
     * makes PHP re-read the file within opcache.revalidate_freq.
     *
     * Only a file whose bytes match the manifest of the release (current manifest
     * required), or, without one, the library when its stamp is the files version: a
     * file that is itself outdated is never touched, its fresh date would hide it.
     * @return array{touched:int,touchFailed:int,libTouched:?bool,touchFailedFiles:string[]}
     *         libTouched: whether the library itself was touched (null = it was not eligible)
     */
    function lumen_probe_touch(string $root, ?string $filesVersion): array {
        $root = rtrim(str_replace(chr(92), '/', $root), '/');
        $touched = 0;
        $failed = 0;
        $failedFiles = [];
        $libTouched = null;
        if ($filesVersion === null) return ['touched' => 0, 'touchFailed' => 0, 'libTouched' => null, 'touchFailedFiles' => []];
        $good = [];
        $mRaw = @is_file($root . '/api/code-manifest.json') ? @file_get_contents($root . '/api/code-manifest.json') : false;
        $mDoc = is_string($mRaw) ? json_decode($mRaw, true) : null;
        if (is_array($mDoc) && ($mDoc['version'] ?? null) === $filesVersion && is_array($mDoc['files'] ?? null)) {
            foreach ($mDoc['files'] as $rel => $sha) {
                if (!is_string($rel) || !is_string($sha) || preg_match('/^(api\/)?[A-Za-z0-9_.-]+\.php$/D', $rel) !== 1) continue;
                $p = $root . '/' . $rel;
                $actual = @is_file($p) && function_exists('hash_file') ? @hash_file('sha256', $p) : false;
                if (is_string($actual) && hash_equals(strtolower($sha), $actual)) $good[] = $p;
            }
        } else {
            $lib = $root . '/api/_admin_lib.php';
            $bytes = @is_file($lib) ? @file_get_contents($lib) : false;
            if (is_string($bytes) && lumen_probe_stamp($bytes) === $filesVersion) $good[] = $lib;
        }
        foreach ($good as $p) {
            if (function_exists('clearstatcache')) @clearstatcache(true, $p);
            $ok = (bool)@touch($p);
            if ($ok) $touched++; else { $failed++; if (count($failedFiles) < 20) $failedFiles[] = substr($p, strlen($root) + 1); }
            if (substr($p, -strlen('/api/_admin_lib.php')) === '/api/_admin_lib.php') $libTouched = $ok;
        }
        return ['touched' => $touched, 'touchFailed' => $failed, 'libTouched' => $libTouched, 'touchFailedFiles' => $failedFiles];
    }
}

if (!function_exists('lumen_probe_has_late_file')) {
    /** A stale manifest is reported but never decides the cause on its own: it is
     *  skipped by SFTP uploads that leave api/*.json alone, while the code is right. */
    function lumen_probe_has_late_file(array $rels, string $manifestRel): bool {
        foreach ($rels as $r) if ($r !== $manifestRel) return true;
        return false;
    }
}

if (!function_exists('lumen_probe_diagnose')) {
    /**
     * @param string  $root             web root (the directory holding api/)
     * @param ?string $filesVersion     version of the files on disk (newest changelog)
     * @param ?string $executingVersion stamp of the code that runs; null = older than 1.84.1
     * @return array{cause:string,executingVersion:?string,filesVersion:?string,library:array,manifest:array,outdated:array,php:array,opcache:array,recovery:?array}
     */
    function lumen_probe_diagnose(string $root, ?string $filesVersion, ?string $executingVersion, bool $recover = true): array {
        $root = rtrim(str_replace('\\', '/', $root), '/');
        $libRel = 'api/_admin_lib.php';
        $manifestRel = 'api/code-manifest.json';

        $libBytes = @is_file($root . '/' . $libRel) ? @file_get_contents($root . '/' . $libRel) : false;
        $diskVersion = is_string($libBytes) ? lumen_probe_stamp($libBytes) : null;
        $cached = null;
        if (function_exists('opcache_is_script_cached')) {
            $c = @opcache_is_script_cached($root . '/' . $libRel);
            $cached = is_bool($c) ? $c : null;
        }

        $manifest = ['present' => false, 'version' => null, 'current' => false];
        $files = null;
        $mRaw = @is_file($root . '/' . $manifestRel) ? @file_get_contents($root . '/' . $manifestRel) : false;
        $mDoc = is_string($mRaw) ? json_decode($mRaw, true) : null;
        if (is_array($mDoc) && isset($mDoc['version']) && is_string($mDoc['version']) && is_array($mDoc['files'] ?? null)) {
            $manifest['present'] = true;
            $manifest['version'] = $mDoc['version'];
            $manifest['current'] = $filesVersion !== null && $mDoc['version'] === $filesVersion;
            $files = $mDoc['files'];
        }

        $outdatedRels = [];
        if ($filesVersion !== null) {
            if ($manifest['current'] && is_array($files)) {
                foreach ($files as $rel => $sha) {
                    // The manifest is data from disk: only shipped-looking PHP paths, never a traversal.
                    if (!is_string($rel) || !is_string($sha) || preg_match('/^(api\/)?[A-Za-z0-9_.-]+\.php$/D', $rel) !== 1) continue;
                    $p = $root . '/' . $rel;
                    $actual = @is_file($p) && function_exists('hash_file') ? @hash_file('sha256', $p) : false;
                    if (!is_string($actual) || !hash_equals(strtolower($sha), $actual)) $outdatedRels[] = $rel;
                    if (count($outdatedRels) >= 100) break;
                }
            } else {
                if ($manifest['present']) $outdatedRels[] = $manifestRel;
                if ($diskVersion !== $filesVersion) $outdatedRels[] = $libRel;
            }
        }
        sort($outdatedRels);
        $outdated = [];
        foreach ($outdatedRels as $rel) $outdated[] = lumen_probe_file_facts($root, $rel);

        if ($diskVersion !== null && $filesVersion !== null
            && lumen_probe_tuple($diskVersion) > lumen_probe_tuple($filesVersion)) {
            $cause = 'incomplete';
        } elseif (lumen_probe_has_late_file($outdatedRels, $manifestRel)) {
            $cause = 'not_written';
        } elseif ($executingVersion !== $filesVersion) {
            $cause = 'opcache';
        } else {
            $cause = 'unknown';
        }

        $opcache = lumen_probe_opcache();
        return [
            'cause' => $cause,
            'executingVersion' => $executingVersion,
            'filesVersion' => $filesVersion,
            'library' => ['path' => $libRel, 'diskVersion' => $diskVersion, 'cached' => $cached],
            'manifest' => $manifest,
            'outdated' => $outdated,
            'php' => ['user' => lumen_probe_php_user()],
            'opcache' => $opcache,
            'recovery' => $recover ? lumen_probe_recover($root, $opcache)
                + ($cause === 'opcache' ? lumen_probe_touch($root, $filesVersion) : ['touched' => 0, 'touchFailed' => 0, 'libTouched' => null, 'touchFailedFiles' => []]) : null,
        ];
    }
}

if (!function_exists('lumen_probe_parked')) {
    /** Update files still parked as *.lumen-new beside their target (self-contained twin of
     *  admin_parked_update_files, which an old library lacks). Paths relative to the root. */
    function lumen_probe_parked(string $root): array {
        $root = rtrim(str_replace(chr(92), '/', $root), '/');
        $cand = [];
        $mRaw = @is_file($root . '/api/.update-pending.json') ? @file_get_contents($root . '/api/.update-pending.json') : false;
        $list = is_string($mRaw) ? json_decode($mRaw, true) : null;
        if (is_array($list)) foreach ($list as $rel) if (is_string($rel) && $rel !== '' && strpos($rel, '..') === false) $cand[$rel] = true;
        if (function_exists('glob')) {
            foreach ([$root . '/api/*.lumen-new', $root . '/*.lumen-new'] as $pattern) {
                foreach ((array)@glob($pattern) as $f) {
                    if (!is_string($f)) continue;
                    $cand[substr(ltrim(str_replace(chr(92), '/', substr($f, strlen($root))), '/'), 0, -strlen('.lumen-new'))] = true;
                }
            }
        }
        $out = [];
        foreach (array_keys($cand) as $rel) if (@is_file($root . '/' . $rel . '.lumen-new')) $out[] = (string)$rel;
        sort($out);
        return $out;
    }
}

if (!function_exists('lumen_probe_fix_next')) {
    /**
     * What is left to do once the fixes ran: a pure decision over facts.
     * Order matters: an update that stopped half-way or files PHP could not write beat
     * everything (the code on disk is wrong, not just its cache); then a dropped cache
     * (the next request is fresh); then dates refreshed under validate_timestamps (opcache
     * re-reads within revalidate_freq); otherwise a human has to act, and `reasons` says why.
     * @param array $f reinstallable, invalidated, swapped, resetOk, touched, touchFailed,
     *                 libTouched, validateTimestamps, revalidateFreq, parkedLeft, invalidateFailed
     * @return array{next:string,waitSeconds:int,reasons:string[]}
     */
    function lumen_probe_fix_next(string $cause, array $f): array {
        if ($cause === 'incomplete') return ['next' => 'manual', 'waitSeconds' => 0, 'reasons' => ['incomplete']];
        if ($cause === 'not_written') {
            return !empty($f['reinstallable'])
                ? ['next' => 'reinstall', 'waitSeconds' => 0, 'reasons' => []]
                : ['next' => 'manual', 'waitSeconds' => 0, 'reasons' => ['not_written', 'reinstall_unavailable']];
        }
        if (($f['invalidated'] ?? 0) > 0 || ($f['swapped'] ?? 0) > 0 || !empty($f['resetOk'])) {
            return ['next' => 'recheck', 'waitSeconds' => 0, 'reasons' => []];
        }
        // Without opcache nothing holds an old compiled copy: the verdict only meant that
        // this request itself compiled the old file, and the next one reads the new one.
        if (($f['opcacheEnabled'] ?? null) === false) return ['next' => 'recheck', 'waitSeconds' => 0, 'reasons' => []];
        $freq = $f['revalidateFreq'] ?? null;
        if (($f['touched'] ?? 0) > 0 && ($f['libTouched'] ?? null) !== false && ($f['validateTimestamps'] ?? null) === true && $freq !== null) {
            // The dates changed: opcache notices at its next check, which is every request at freq 0.
            if ($freq === 0) return ['next' => 'recheck', 'waitSeconds' => 0, 'reasons' => []];
            if ($freq > 0) return ['next' => 'wait', 'waitSeconds' => (int)$freq, 'reasons' => []];
        }
        $reasons = [];
        if (!empty($f['parkedLeft'])) $reasons[] = 'parked';
        if (($f['touchFailed'] ?? 0) > 0) $reasons[] = 'touch_failed';
        if (!empty($f['invalidateFailed'])) $reasons[] = 'opcache_blocked';
        if (!$reasons) $reasons[] = 'reupload';
        return ['next' => 'manual', 'waitSeconds' => 0, 'reasons' => $reasons];
    }
}

if (!function_exists('lumen_probe_fix')) {
    /**
     * Every correction the server can make by itself, in order, then what is left to do.
     *
     * Runs beside an OLD library: whatever it needs from api/_admin_lib.php
     * (admin_update_finish_pending, admin_apply_tree_modes) is called only when it
     * exists, and a step that cannot run is reported as such, never as a fatal.
     *
     * actions (always these five, in this order): {id, ran, ok, count?, failed?, detail?}
     *   finish_parked       update files parked as *.lumen-new swapped into place
     *   invalidate          the compiled copy of every served PHP file dropped (opcache_invalidate)
     *   touch               modification time refreshed on the files that match the release
     *   repair_permissions  modes of the install re-applied (only when files could not be
     *                       written, or a date could not be refreshed: it walks the whole tree)
     *   opcache_reset       the whole opcache emptied, only when per-file invalidation does not
     *                       exist at all (one attempt per minute, the library's throttle file)
     * next: 'reinstall' (files PHP could not write: reinstall this version through
     *       update_apply), 'recheck' (the next request runs the new files), 'wait' (dates
     *       refreshed, opcache re-reads them within waitSeconds), 'manual' (see reasons).
     * @return array{stale:bool,cause:string,actions:array,next:string,waitSeconds:int,reasons:string[]}
     */
    function lumen_probe_fix(string $root, ?string $filesVersion, ?string $executingVersion): array {
        $root = rtrim(str_replace(chr(92), '/', $root), '/');
        $reasons = [];
        $step = function (string $id, bool $ran = false, bool $ok = false, array $more = []): array {
            return array_merge(['id' => $id, 'ran' => $ran, 'ok' => $ok], $more);
        };
        $parked = $step('finish_parked');
        $inv = $step('invalidate');
        $touch = $step('touch');
        $perm = $step('repair_permissions');
        $reset = $step('opcache_reset');

        // 1. Parked update files.
        $before = lumen_probe_parked($root);
        // The door of admin.php already swapped what it could before this request got here.
        $swapped = max(0, (int)($GLOBALS['lumen_pending_swapped'] ?? 0));
        $doorSwapped = $swapped;
        $left = $before;
        if (!$before && $doorSwapped > 0) $parked = $step('finish_parked', true, true, ['count' => $doorSwapped, 'failed' => 0]);
        $finishFn = 'admin_update_finish_pending';   // the library's, when it has it: called by name, never required
        if ($before && function_exists($finishFn)) {
            try {
                $swapped = $doorSwapped + (int)$finishFn();
            } catch (\Throwable $e) {
                error_log('stale-code fix (parked) failed: ' . $e->getMessage());
            }
            $left = lumen_probe_parked($root);
            $parked = $step('finish_parked', true, count($left) === 0, ['count' => $swapped, 'failed' => count($left)]
                + ($left ? ['detail' => array_slice($left, 0, 20)] : []));
        }

        // 2. What is wrong now (the swap may have changed it).
        $d0 = lumen_probe_diagnose($root, $filesVersion, $executingVersion, false);
        $cause = (string)$d0['cause'];
        $touchOwed = $filesVersion !== null && in_array($cause, ['opcache', 'unknown'], true);
        $invalidated = 0;
        $rec = null;
        $t = ['touched' => 0, 'touchFailed' => 0, 'libTouched' => null, 'touchFailedFiles' => []];

        // 3. Drop the compiled copies, then give the right files a fresh date.
        if ($touchOwed) {
            $rec = lumen_probe_recover($root, $d0['opcache']);
            $invalidated = (int)$rec['invalidated'];
            $inv = $step('invalidate', true, $invalidated > 0, ['count' => $invalidated, 'failed' => max(0, (int)$rec['tried'] - $invalidated)]
                + (!empty($rec['blocked']) ? ['detail' => ['blocked']] : []));
            $t = lumen_probe_touch($root, $filesVersion);
            $touch = $step('touch', true, $t['touchFailed'] === 0 && $t['touched'] > 0,
                ['count' => $t['touched'], 'failed' => $t['touchFailed']] + ($t['touchFailedFiles'] ? ['detail' => $t['touchFailedFiles']] : []));
        }

        // 4. Permissions: the files PHP could not write, or dates it could not refresh.
        if ($cause === 'not_written' || $t['touchFailed'] > 0) {
            $modesFn = 'admin_apply_tree_modes';
            if (function_exists($modesFn)) {
                try {
                    $r = $modesFn();
                    $unwritable = is_array($r['codeUnwritable'] ?? null) ? $r['codeUnwritable'] : [];
                    $paths = array_values(array_unique(array_merge(is_array($r['failedPaths'] ?? null) ? $r['failedPaths'] : [], $unwritable)));
                    $perm = $step('repair_permissions', true, (int)($r['failed'] ?? 0) === 0 && !$unwritable,
                        ['count' => (int)($r['fixed'] ?? 0), 'failed' => (int)($r['failed'] ?? 0)] + ($paths ? ['detail' => array_slice($paths, 0, 20)] : []));
                    if ($unwritable) $reasons[] = 'unwritable';
                } catch (\Throwable $e) {
                    error_log('stale-code fix (permissions) failed: ' . $e->getMessage());
                    $perm = $step('repair_permissions', true, false, ['count' => 0, 'failed' => 0]);
                }
                if ($touchOwed && $t['touchFailed'] > 0) {   // the modes may now allow the dates to change
                    $t = lumen_probe_touch($root, $filesVersion);
                    $touch = $step('touch', true, $t['touchFailed'] === 0 && $t['touched'] > 0,
                        ['count' => $t['touched'], 'failed' => $t['touchFailed']] + ($t['touchFailedFiles'] ? ['detail' => $t['touchFailedFiles']] : []));
                }
            } else {
                $perm = $step('repair_permissions', false, false, ['detail' => ['unavailable']]);
            }
        }

        // 5. Without per-file invalidation, the whole cache: once a minute at most.
        $oc = $d0['opcache'];
        if ($touchOwed && !empty($oc['enabled']) && $invalidated === 0
            && !function_exists('opcache_invalidate') && function_exists('opcache_reset')) {
            $stamp = $root . '/api/.stale-recovery.json';
            $prev = @is_file($stamp) ? json_decode((string)@file_get_contents($stamp), true) : null;
            $recent = is_array($prev) && isset($prev['at']) && is_int($prev['at']) && time() - $prev['at'] >= 0 && time() - $prev['at'] < 60;
            if ($recent) {
                $reset = $step('opcache_reset', false, false, ['detail' => ['throttled']]);
            } else {
                $done = (bool)@opcache_reset();
                $reset = $step('opcache_reset', true, $done);
                @file_put_contents($stamp, json_encode(['at' => time(), 'result' => ['opcacheReset' => $done, 'throttled' => false, 'source' => 'probe']]));
            }
        }

        // 6. A fresh look, then what is left.
        $d1 = lumen_probe_diagnose($root, $filesVersion, $executingVersion, false);
        $decision = lumen_probe_fix_next((string)$d1['cause'], [
            'reinstallable' => defined('LUMEN_UPDATE_REINSTALL') && LUMEN_UPDATE_REINSTALL === true,
            'invalidated' => $invalidated, 'swapped' => $swapped, 'resetOk' => $reset['ok'],
            'touched' => (int)($touch['count'] ?? 0), 'touchFailed' => (int)$t['touchFailed'], 'libTouched' => $t['libTouched'],
            'validateTimestamps' => $d1['opcache']['validateTimestamps'], 'revalidateFreq' => $d1['opcache']['revalidateFreq'],
            'parkedLeft' => (bool)$left, 'invalidateFailed' => is_array($rec) && !empty($rec['blocked']),
            'opcacheEnabled' => $d1['opcache']['enabled'] ?? null,
        ]);
        $next = $decision['next'];
        $wait = $decision['waitSeconds'];
        $reasons = array_merge($reasons, $decision['reasons']);
        $cause1 = (string)$d1['cause'];
        return [
            'stale' => true,
            'cause' => $cause1,
            'actions' => [$parked, $inv, $touch, $perm, $reset],
            'next' => $next,
            'waitSeconds' => $wait,
            'reasons' => array_values(array_unique($reasons)),
        ];
    }
}
