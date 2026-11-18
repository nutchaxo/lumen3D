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
            'recovery' => $recover ? lumen_probe_recover($root, $opcache) : null,
        ];
    }
}
