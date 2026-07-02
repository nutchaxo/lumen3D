<?php
/**
 * IRIBHM Microscopy Platform — Dataset CRUD API
 * ===============================================
 * Read and write dataset metadata.json files.
 * Also handles catalog.json regeneration.
 *
 * Endpoints:
 *   GET  ?action=list              → [{id, name, type, stage, thumbnail, configured}, ...]
 *   GET  ?action=get&id=<id>       → full metadata.json object
 *   POST ?action=save&id=<id>      → writes metadata.json, returns {ok}
 *   POST ?action=rebuild_catalog   → regenerates DATA_WEB/catalog.json
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

require_once __DIR__ . '/_admin_lib.php';  // admin_check_csrf, admin_record_event, etc.

// ── Session / Auth ───────────────────────────────────────────────────────────
session_name('iribhm_admin');
session_start();

function require_auth(): void {
    if (empty($_SESSION['admin_authenticated'])) {
        json_out(['error' => 'Unauthorized'], 401);
    }
}

// No `: never` return type — 8.1+ syntax that would parse-error (500) on the
// advertised PHP >= 7.4 floor. It exits anyway.
function json_out(array $data, int $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

// ── Paths ────────────────────────────────────────────────────────────────────
$ROOT      = dirname(__DIR__);                  // WebPlatform root
$DATA_WEB  = $ROOT . DIRECTORY_SEPARATOR . 'DATA_WEB';
$TYPES     = ['fixed', 'live', 'tracking'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function read_json(string $path): ?array {
    if (!file_exists($path)) return null;
    $raw = file_get_contents($path);
    return $raw !== false ? (json_decode($raw, true) ?: null) : null;
}

function write_json(string $path, array $data): bool {
    $dir = dirname($path);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    return file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) !== false;
}

function dataset_id(string $type, string $name): string {
    return $type . '/' . $name;
}

function dataset_dir(string $id): string {
    global $DATA_WEB;
    return $DATA_WEB . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $id);
}

function thumbnail_url(string $id): ?string {
    $path = dataset_dir($id) . DIRECTORY_SEPARATOR . 'thumbnail.webp';
    return file_exists($path) ? 'DATA_WEB/' . $id . '/thumbnail.webp' : null;
}

function list_datasets(): array {
    global $DATA_WEB, $TYPES;
    $result = [];
    foreach ($TYPES as $type) {
        $type_dir = $DATA_WEB . DIRECTORY_SEPARATOR . $type;
        if (!is_dir($type_dir)) continue;
        foreach (scandir($type_dir) as $name) {
            if ($name === '.' || $name === '..') continue;
            $ds_dir = $type_dir . DIRECTORY_SEPARATOR . $name;
            if (!is_dir($ds_dir)) continue;
            $id   = $type . '/' . $name;
            $meta = read_json($ds_dir . DIRECTORY_SEPARATOR . 'metadata.json');
            $hasBricks = file_exists($ds_dir . DIRECTORY_SEPARATOR . 'bricks' . DIRECTORY_SEPARATOR . 'manifest.json');
            $result[] = [
                'id'          => $id,
                'name'        => $meta['name'] ?? $name,
                'folderName'  => $name,
                'type'        => $type,
                'stage'       => $meta['stage'] ?? null,
                'stageNumeric'=> $meta['stageNumeric'] ?? 0,
                'embryo'      => $meta['embryo'] ?? null,
                'channels'    => $meta['channels'] ?? [],
                'dimensions'  => $meta['dimensions'] ?? [],
                'thumbnail'   => thumbnail_url($id),
                'configured'  => isset($meta['_adminConfigured']) && $meta['_adminConfigured'],
                'hidden'      => !empty($meta['hidden']),
                'hasBricks'   => $hasBricks,
            ];
        }
    }
    // Sort by stageNumeric then name
    usort($result, fn($a, $b) =>
        ($a['stageNumeric'] <=> $b['stageNumeric']) ?: strcmp($a['name'], $b['name'])
    );
    return $result;
}

/**
 * Rebuild DATA_WEB/catalog.json from all metadata.json files.
 * Mirrors the logic of generate_catalog.py in pure PHP.
 */
function rebuild_catalog(): array {
    global $DATA_WEB, $TYPES;

    $CHANNEL_COLORS = ['#00FF66', '#FF3DFF', '#2F6BFF', '#FF3030'];
    $catalog = ['datasets' => [], 'last_updated' => date('c')];

    foreach ($TYPES as $type) {
        $type_dir = $DATA_WEB . DIRECTORY_SEPARATOR . $type;
        if (!is_dir($type_dir)) continue;
        foreach (scandir($type_dir) as $name) {
            if ($name[0] === '.') continue;
            $ds_dir   = $type_dir . DIRECTORY_SEPARATOR . $name;
            if (!is_dir($ds_dir)) continue;
            $meta     = read_json($ds_dir . DIRECTORY_SEPARATOR . 'metadata.json');
            if (!$meta) continue;
            if (!empty($meta['hidden'])) continue;   // hidden datasets are excluded from the public catalog

            $id = $type . '/' . $name;

            // Channels
            $raw_channels = $meta['channels'] ?? [];
            $n_ch = (int)($meta['dimensions']['c'] ?? count($raw_channels));
            $channels_out = [];
            for ($i = 0; $i < $n_ch; $i++) {
                $raw = is_array($raw_channels) ? ($raw_channels[$i] ?? null) : null;
                // Admin may store channels as [{name, color, min, max, gamma, active}]
                if (is_array($raw)) {
                    $channels_out[] = [
                        'name'   => $raw['name']  ?? "Channel " . ($i+1),
                        'color'  => $raw['color']  ?? $CHANNEL_COLORS[$i % 4],
                        'min'    => $raw['min']    ?? 0.0,
                        'max'    => $raw['max']    ?? 1.0,
                        'gamma'  => $raw['gamma']  ?? 1.0,
                        'active' => $raw['active'] ?? true,
                    ];
                } else {
                    // Legacy: channels is array of strings
                    $channels_out[] = [
                        'name'  => (string)($raw ?? "Channel " . ($i+1)),
                        'color' => $CHANNEL_COLORS[$i % 4],
                    ];
                }
            }

            // Physical calibration
            $vs = $meta['voxel_size'] ?? [];
            $dims = $meta['dimensions'] ?? [];
            $vx = (float)($vs['x'] ?? 1.0);
            $vy = (float)($vs['y'] ?? $vx);
            $vz = (float)($vs['z'] ?? 1.0);
            $sx = (int)($dims['x'] ?? 1);
            $sy = (int)($dims['y'] ?? 1);
            $sz = (int)($dims['z'] ?? 1);
            $physical = [
                'x' => $sx * $vx, 'y' => $sy * $vy,
                'z' => $sz > 1 ? (($sz - 1) * $vz + $vz) : $vz,
                'sliceThickness' => $vz,
                'voxelX' => $vx, 'voxelY' => $vy, 'voxelZ' => $vz,
            ];

            // Asset paths
            $thumb_path = $ds_dir . DIRECTORY_SEPARATOR . 'thumbnail.webp';
            $slices_dir = $ds_dir . DIRECTORY_SEPARATOR . 'slices';
            $prev_manifest = $ds_dir . DIRECTORY_SEPARATOR . 'preview' . DIRECTORY_SEPARATOR . 'manifest.json';

            $entry = [
                'id'            => $meta['id'] ?? $name,
                'name'          => $meta['name'] ?? $name,
                'type'          => $type,
                'stage'         => $meta['stage'] ?? 'Unknown',
                'stageNumeric'  => $meta['stageNumeric'] ?? 0,
                'embryo'        => $meta['embryo'] ?? null,
                'description'   => $meta['description'] ?? null,
                'tags'          => $meta['tags'] ?? [],
                'path'          => $id,
                'channels'      => $channels_out,
                'dimensions'    => $dims,
                'voxel_size'    => $vs,
                'physicalSizeUm'=> $physical,
            ];

            if (file_exists($thumb_path)) {
                $entry['thumbnail'] = 'DATA_WEB/' . $id . '/thumbnail.webp';
            }
            if (isset($meta['qualities'])) {
                $entry['qualities'] = $meta['qualities'];
            }
            if (isset($meta['volumeSources'])) {
                $entry['volumeSources'] = $meta['volumeSources'];
            }

            // Fallbacks for older datasets that don't have them in metadata.json
            if (!isset($entry['qualities']) && file_exists($prev_manifest)) {
                $entry['qualities']['preview'] = read_json($prev_manifest);
            }
            if (!isset($entry['qualities']) && is_dir($slices_dir)) {
                $entry['qualities']['balanced'] = [
                    'directory' => 'slices', 'maxTextureSize' => 640, 'maxDepthSamples' => 128
                ];
                $entry['qualities']['high'] = [
                    'directory' => 'slices', 'maxTextureSize' => 1024, 'maxDepthSamples' => 192
                ];
            }
            
            // Volume sources fallback
            $brick_manifest = $ds_dir . DIRECTORY_SEPARATOR . 'bricks' . DIRECTORY_SEPARATOR . 'manifest.json';
            if (!isset($entry['volumeSources'])) {
                if (is_dir($slices_dir)) {
                    $entry['volumeSources'] = [
                        ['kind' => 'webstack', 'label' => 'Web slice stack', 'priority' => 0,
                         'available' => true, 'multiscale' => false,
                         'path' => 'DATA_WEB/' . $id],
                    ];
                } else {
                    $entry['volumeSources'] = [];
                }
                
                if (file_exists($brick_manifest)) {
                    array_unshift($entry['volumeSources'], [
                        'kind' => 'bricks', 'label' => 'Chunked bricks', 'priority' => -1,
                        'available' => true, 'multiscale' => true,
                        'path' => 'DATA_WEB/' . $id,
                        'manifestPath' => 'DATA_WEB/' . $id . '/bricks/manifest.json',
                    ]);
                }
            }

            // Filter nulls
            $entry = array_filter($entry, fn($v) => $v !== null);
            $catalog['datasets'][] = $entry;
        }
    }

    return $catalog;
}

// ── Router ───────────────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$id     = trim($_GET['id'] ?? '', '/');

// All write operations require auth + a valid CSRF token (mirrors dev_server.py)
if ($method === 'POST') {
    require_auth();
    if (!admin_check_csrf()) json_out(['error' => 'Invalid or missing CSRF token'], 403);
}

switch ($action) {

    case 'list':
        json_out(['datasets' => list_datasets()]);

    case 'get':
        if (!$id) json_out(['error' => 'Missing id'], 400);
        $meta = read_json(dataset_dir($id) . DIRECTORY_SEPARATOR . 'metadata.json');
        if (!$meta) json_out(['error' => 'Not found'], 404);
        json_out($meta);

    case 'save':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);

        $body = json_decode(file_get_contents('php://input'), true);
        if (!is_array($body)) json_out(['error' => 'Invalid JSON body'], 400);

        // Security: only allow safe keys, never allow path traversal
        if (strpos($id, '..') !== false) json_out(['error' => 'Invalid id'], 400);

        // Mark as admin-configured
        $body['_adminConfigured'] = true;
        $body['_lastModified']    = date('c');

        $path = dataset_dir($id) . DIRECTORY_SEPARATOR . 'metadata.json';
        if (!write_json($path, $body)) json_out(['error' => 'Write failed'], 500);

        json_out(['ok' => true, 'path' => $path]);

    case 'save_thumbnail':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);

        $body = json_decode(file_get_contents('php://input'), true);
        if (!is_array($body) || empty($body['image'])) json_out(['error' => 'Invalid body or missing image'], 400);

        // Security: only allow safe keys, never allow path traversal
        if (strpos($id, '..') !== false) json_out(['error' => 'Invalid id'], 400);

        $imgData = $body['image'];
        if (preg_match('/^data:image\/(\w+);base64,/', $imgData, $type)) {
            $imgData = substr($imgData, strpos($imgData, ',') + 1);
            $imgData = base64_decode($imgData);
            if ($imgData === false) {
                json_out(['error' => 'Base64 decode failed'], 400);
            }
        } else {
            json_out(['error' => 'Invalid image format'], 400);
        }

        $ds_dir = dataset_dir($id);
        if (!is_dir($ds_dir)) {
            json_out(['error' => 'Dataset directory does not exist'], 404);
        }

        $thumb_path = $ds_dir . DIRECTORY_SEPARATOR . 'thumbnail.webp';
        if (file_put_contents($thumb_path, $imgData) === false) {
            json_out(['error' => 'Failed to write thumbnail file'], 500);
        }

        json_out(['ok' => true, 'path' => 'DATA_WEB/' . $id . '/thumbnail.webp']);

    case 'rebuild_catalog':
        require_auth();
        $catalog = rebuild_catalog();
        $catalog_path = $DATA_WEB . DIRECTORY_SEPARATOR . 'catalog.json';
        if (!write_json($catalog_path, $catalog)) json_out(['error' => 'Catalog write failed'], 500);
        json_out(['ok' => true, 'count' => count($catalog['datasets'])]);

    case 'set_visibility':
        require_auth();
        if (!$id) json_out(['error' => 'Missing id'], 400);
        if (strpos($id, '..') !== false) json_out(['error' => 'Invalid id'], 400);
        $body = json_decode(file_get_contents('php://input'), true) ?: [];
        $meta_path = dataset_dir($id) . DIRECTORY_SEPARATOR . 'metadata.json';
        $meta = read_json($meta_path);
        if (!$meta) json_out(['error' => 'Not found'], 404);
        $meta['hidden'] = !empty($body['hidden']);
        $meta['_lastModified'] = date('c');
        if (!write_json($meta_path, $meta)) json_out(['error' => 'Write failed'], 500);
        $catalog = rebuild_catalog();
        write_json($DATA_WEB . DIRECTORY_SEPARATOR . 'catalog.json', $catalog);
        json_out(['ok' => true, 'hidden' => $meta['hidden']]);

    default:
        json_out(['error' => 'Unknown action'], 400);
}
