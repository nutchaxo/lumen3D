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

admin_session_start();
if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);

$action = $_GET['action'] ?? '';
$body   = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' ? (json_decode(file_get_contents('php://input'), true) ?: []) : [];

if (in_array($action, ['set_plugin', 'update_apply'], true)) admin_require_write();

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
        $enabledShaders = array_filter($plugins, fn($p) => ($p['placement'] ?? '') === 'shaders' && !in_array($p['path'], $disabled, true));
        $enabledShaderPaths = array_map(fn($p) => $p['path'], $enabledShaders);
        $out = [];
        foreach ($plugins as $p) {
            $isEnabled = !in_array($p['path'], $disabled, true);
            [$compatOk, $compatReason] = admin_compat_satisfies($ver, $p['platformCompat'] ?? null);
            $out[] = [
                'id' => $p['id'] ?? null, 'path' => $p['path'], 'placement' => $p['placement'] ?? null,
                'name' => $p['name'] ?? ($p['id'] ?? $p['path']), 'icon' => $p['icon'] ?? null,
                'group' => $p['group'] ?? null, 'subtype' => $p['subtype'] ?? null,
                'version' => $p['version'] ?? null, 'creator' => $p['creator'] ?? null,
                'enabled' => $isEnabled,
                'protected' => count($enabledShaderPaths) <= 1 && in_array($p['path'], $enabledShaderPaths, true),
                'platformCompat' => $p['platformCompat'] ?? null,
                'compat' => $compatOk, 'compatReason' => $compatReason,
            ];
        }
        usort($out, fn($a, $b) => [$a['placement'], $a['group'] ?? '', $a['name'] ?? ''] <=> [$b['placement'], $b['group'] ?? '', $b['name'] ?? '']);
        admin_json_out(['plugins' => $out]);
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

    case 'update_apply':
        // Self-update + restart is tied to the long-lived Python process. Under
        // PHP-FPM/Apache there is no reliable in-process restart, so the UI is told
        // to fall back to a manual update (use the Python server, or update by hand).
        admin_json_out(['supported' => false, 'error' => 'unsupported_on_php'], 400);

    default:
        admin_json_out(['error' => 'Unknown action'], 400);
}
