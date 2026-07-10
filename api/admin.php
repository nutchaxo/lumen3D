<?php
/**
 * IRIBHM Microscopy Platform — Admin feature endpoints (PHP fallback)
 * ===================================================================
 * Mirrors dev_server.py /api/admin.php. All actions require an authenticated
 * session; writes additionally require the CSRF token.
 *
 *   GET  ?action=stats          → {global, daily, datasets:[...]}
 *   GET  ?action=plugins        → {plugins:[{...,enabled,protected}]}
 *   POST ?action=set_plugin     {id,enabled} → {ok}
 *   GET  ?action=version        → {web, devServer, preprocess, repo}
 *   GET  ?action=update_check   → {current, latest, available, ...}
 *   GET  ?action=update_status  → {phase,...}
 *   POST ?action=update_apply   → {supported:false}  (self-restart unsupported under PHP)
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

admin_update_finish_pending();   // no-op unless a prior update parked busy files
admin_session_start();
if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);

$action = $_GET['action'] ?? '';
$body   = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? (json_decode(file_get_contents('php://input'), true) ?: []) : [];

if (in_array($action, ['set_plugin', 'update_apply', 'approve_plugin', 'revoke_plugin', 'install_plugin', 'uninstall_plugin'], true)) admin_require_write();

switch ($action) {

    case 'stats': {
        $stats = admin_load_stats();
        // Enrich per-dataset rows with display names from catalog.json (if present).
        $names = [];
        $cat = admin_read_json(data_web() . '/catalog.json');
        if (is_array($cat)) {
            $list = isset($cat['datasets']) && is_array($cat['datasets']) ? $cat['datasets'] : $cat;
            foreach ($list as $ds) { if (isset($ds['path'])) $names[$ds['path']] = $ds['name'] ?? $ds['path']; }
        }
        $rows = [];
        foreach (($stats['datasets'] ?? []) as $id => $v) {
            $rows[] = [
                'id' => $id, 'name' => $names[$id] ?? $id,
                'views' => (int)($v['views'] ?? 0), 'downloads' => (int)($v['downloads'] ?? 0),
                'lastViewed' => $v['lastViewed'] ?? null,
            ];
        }
        usort($rows, fn($a, $b) => ($b['views'] + $b['downloads']) <=> ($a['views'] + $a['downloads']));
        admin_json_out(['global' => $stats['global'] ?? [], 'daily' => $stats['daily'] ?? [], 'datasets' => $rows]);
    }

    case 'plugins': {
        $disabled = admin_load_disabled();
        $plugins = admin_list_plugins();
        $ver = admin_max_version(changelog_dir());
        $approvals = admin_load_trust();
        $manifest = admin_release_manifest();
        $enabledShaders = array_filter($plugins, fn($p) => ($p['placement'] ?? '') === 'shaders' && !in_array($p['path'], $disabled, true));
        $enabledShaderPaths = array_map(fn($p) => $p['path'], $enabledShaders);
        $out = [];
        foreach ($plugins as $p) {
            $isEnabled = !in_array($p['path'], $disabled, true);
            [$compatOk, $compatReason] = admin_compat_satisfies($ver, $p['platformCompat'] ?? null);
            $tr = admin_classify_plugin($p['path'], modules_dir() . '/' . $p['path'], $approvals, $manifest);
            $out[] = [
                'id' => $p['id'] ?? null, 'path' => $p['path'], 'placement' => $p['placement'] ?? null,
                'name' => $p['name'] ?? ($p['id'] ?? $p['path']), 'icon' => $p['icon'] ?? null,
                'group' => $p['group'] ?? null, 'subtype' => $p['subtype'] ?? null,
                'version' => $p['version'] ?? null, 'creator' => $p['creator'] ?? null,
                'enabled' => $isEnabled,
                'protected' => count($enabledShaderPaths) <= 1 && in_array($p['path'], $enabledShaderPaths, true),
                'platformCompat' => $p['platformCompat'] ?? null,
                'compat' => $compatOk, 'compatReason' => $compatReason,
                'trust' => ['tier' => $tr['tier'], 'hash' => $tr['hash'], 'mode' => $tr['mode'] ?? null,
                            'caps' => $tr['caps'] ?? null, 'reason' => $tr['reason'] ?? null,
                            'declaredCaps' => admin_plugin_declared_caps(modules_dir() . '/' . $p['path'])],
            ];
        }
        usort($out, fn($a, $b) => [$a['placement'], $a['group'] ?? '', $a['name'] ?? ''] <=> [$b['placement'], $b['group'] ?? '', $b['name'] ?? '']);
        admin_json_out(['plugins' => $out]);
    }

    case 'plugin_trust':
        admin_json_out(['approvals' => admin_load_trust(), 'devTrust' => admin_dev_trust()]);

    case 'approve_plugin': {
        // INV-4: re-auth with the current password; the server re-hashes on disk and
        // requires client==server agreement on the exact bytes.
        $rec = admin_credential();
        if (!$rec || !admin_verify_password($body['password'] ?? '', $rec['password_pbkdf2'] ?? '')) admin_json_out(['error' => 'bad_password'], 401);
        $path = $body['path'] ?? ''; $mode = $body['mode'] ?? '';
        if (!in_array($mode, ['trusted', 'sandboxed'], true)) admin_json_out(['error' => 'bad_mode'], 400);
        if (!preg_match('#^(tools|channels|shaders)/[A-Za-z0-9_][A-Za-z0-9._-]*$#', $path)) admin_json_out(['error' => 'bad_path'], 400);
        $modDir = modules_dir() . '/' . $path;
        if (!is_file($modDir . '/plugin.json')) admin_json_out(['error' => 'unknown_plugin'], 404);
        $serverHash = admin_plugin_hash(admin_plugin_file_hashes($modDir));
        if (($body['sha256'] ?? '') !== $serverHash) admin_json_out(['error' => 'hash_mismatch', 'serverHash' => $serverHash], 409);
        $declared = admin_plugin_declared_caps($modDir);
        $caps = array_values(array_intersect(is_array($body['caps'] ?? null) ? $body['caps'] : [], SANDBOX_CAP_ALLOWLIST));
        $caps = array_values(array_unique(array_merge($caps, $declared)));
        $approvals = array_values(array_filter(admin_load_trust(), fn($a) => ($a['path'] ?? '') !== $path));
        $approvals[] = ['path' => $path, 'sha256' => $serverHash, 'mode' => $mode, 'caps' => $caps,
                        'at' => date('c'), 'by' => $_SESSION['admin_user'] ?? 'admin'];
        admin_save_trust($approvals);
        admin_json_out(['ok' => true, 'hash' => $serverHash, 'mode' => $mode, 'caps' => $caps]);
    }

    case 'revoke_plugin': {
        $path = $body['path'] ?? '';
        $approvals = admin_load_trust();
        $remaining = array_values(array_filter($approvals, fn($a) => ($a['path'] ?? '') !== $path));
        if (count($remaining) === count($approvals)) admin_json_out(['error' => 'not_approved'], 404);
        admin_save_trust($remaining);
        admin_json_out(['ok' => true]);
    }

    // ── Marketplace (curated signed plugin catalog) — twin of dev_server.py ──
    case 'marketplace_catalog':
        admin_json_out(mkt_list());

    case 'install_plugin': {
        [$st, $pl] = mkt_install((string)($body['id'] ?? ''), (string)($body['password'] ?? ''));
        admin_json_out($pl, $st);
    }

    case 'uninstall_plugin': {
        [$st, $pl] = mkt_uninstall((string)($body['path'] ?? ''));
        admin_json_out($pl, $st);
    }

    case 'set_plugin': {
        $path = $body['id'] ?? '';
        $enabled = (bool)($body['enabled'] ?? true);
        $known = array_map(fn($p) => $p['path'], admin_list_plugins());
        if (!in_array($path, $known, true)) admin_json_out(['error' => 'unknown_plugin'], 404);
        $disabled = admin_load_disabled();
        if (!$enabled) {
            if (strncmp($path, 'shaders/', 8) === 0) {
                $enabledShaders = array_values(array_filter(admin_list_plugins(),
                    fn($p) => ($p['placement'] ?? '') === 'shaders' && !in_array($p['path'], $disabled, true)));
                if (count($enabledShaders) <= 1 && in_array($path, array_map(fn($p) => $p['path'], $enabledShaders), true)) {
                    admin_json_out(['error' => 'last_shader'], 409);
                }
            }
            if (!in_array($path, $disabled, true)) $disabled[] = $path;
        } else {
            $disabled = array_values(array_filter($disabled, fn($x) => $x !== $path));
        }
        admin_save_disabled($disabled);
        admin_json_out(['ok' => true, 'enabled' => $enabled]);
    }

    case 'version':
        admin_json_out([
            'web' => admin_max_version(changelog_dir()),
            'devServer' => null,                 // PHP host has no dev-server version
            'preprocess' => admin_preprocess_version(),
            'repo' => GITHUB_REPO,
        ]);

    case 'update_check': {
        $current = admin_max_version(changelog_dir()) ?? '0.0.0';
        $ctx = stream_context_create(['http' => ['header' => "User-Agent: lumen3d-admin\r\nAccept: application/vnd.github+json\r\n", 'timeout' => 10, 'ignore_errors' => true]]);
        $raw = @file_get_contents("https://api.github.com/repos/" . GITHUB_REPO . "/releases/latest", false, $ctx);
        if ($raw === false) admin_json_out(['current' => $current, 'latest' => null, 'available' => false, 'error' => 'unreachable']);
        $rel = json_decode($raw, true);
        if (!is_array($rel) || !isset($rel['tag_name'])) admin_json_out(['current' => $current, 'latest' => null, 'available' => false, 'noReleases' => true]);
        $latest = ltrim((string)$rel['tag_name'], 'v');
        admin_json_out([
            'current' => $current, 'latest' => $latest,
            'available' => admin_version_tuple($latest) > admin_version_tuple($current),
            'notes' => $rel['body'] ?? null, 'publishedAt' => $rel['published_at'] ?? null,
            'zipUrl' => $rel['zipball_url'] ?? null, 'htmlUrl' => $rel['html_url'] ?? null,
        ]);
    }

    case 'update_preflight': {
        // Compat report against the target version (mirrors dev_server.py). PHP
        // can't self-apply, but the admin UI still shows which plugins a manual
        // upgrade would render incompatible.
        $target = $_GET['target'] ?? null;
        $current = admin_max_version(changelog_dir());
        $disabled = admin_load_disabled();
        $ok = []; $willQuarantine = []; $blocking = []; $shadersSurviving = 0;
        foreach (admin_list_plugins() as $p) {
            [$okT] = admin_compat_satisfies($target, $p['platformCompat'] ?? null);
            $entry = ['path' => $p['path'], 'name' => $p['name'] ?? ($p['id'] ?? null), 'platformCompat' => $p['platformCompat'] ?? null];
            if ($okT) {
                $ok[] = $entry;
                if (($p['placement'] ?? '') === 'shaders' && !in_array($p['path'], $disabled, true)) $shadersSurviving++;
            } else {
                [$okNow] = admin_compat_satisfies($current, $p['platformCompat'] ?? null);
                $entry['okNow'] = $okNow;
                $willQuarantine[] = $entry;
            }
        }
        if ($target && $shadersSurviving === 0) {
            $blocking[] = ['reason' => 'no_render_mode', 'detail' => 'Aucun mode de rendu (shader) ne resterait compatible.'];
        }
        admin_json_out(['target' => $target, 'current' => $current, 'ok' => $ok, 'willQuarantine' => $willQuarantine, 'blocking' => $blocking]);
    }

    case 'update_status':
        admin_json_out(['phase' => 'idle', 'pct' => 0, 'message' => '', 'running' => false]);

    case 'update_apply': {
        // PHP is per-request (no process to restart): download → verify → staged
        // extract → protected copy-over, synchronously. The response carries the
        // outcome directly (`applied`) — no status pipeline to poll, unlike the
        // Python server's Blue-Green swap.
        [$code, $payload] = admin_update_apply_php();
        admin_json_out($payload, $code);
    }

    default:
        admin_json_out(['error' => 'Unknown action'], 400);
}
