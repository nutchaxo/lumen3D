<?php
/**
 * Lumen3D — Media library API (operator image uploads). PHP twin of the
 * dev_server.py /api/media.php handler.
 *
 *   POST ?action=list                         → { files:[{name,url,size}] }  (admin)
 *   POST ?action=upload  { filename, data }   → { ok, url }                  (admin + CSRF)
 *   POST ?action=delete  { name }             → { ok }                       (admin + CSRF)
 *
 * `data` is the base64 image bytes (a data: URL prefix is stripped). Files land
 * under the PUBLIC config/uploads/ dir (world-readable 0644) so the public pages
 * can serve them. Raster only — SVG is excluded (it could carry inline script).
 */
declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';
admin_session_start();
// Read-only use of the session from here on (auth, CSRF): release its lock so this
// request never serialises with the rest of the admin (see api/admin.php).
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();

$action = lumen_str($_GET['action'] ?? null) ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = $method === 'POST' ? (lumen_request_json() ?? []) : [];

const MEDIA_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'];
const MEDIA_MAX = 8388608; // 8 MB decoded

function media_dir(): string { return admin_root() . '/config/uploads'; }

function media_safe_name(string $name): ?string {
    $name  = str_replace('\\', '/', trim($name));
    $parts = explode('/', $name);
    $name  = (string)end($parts);
    $dot   = strrpos($name, '.');
    if ($dot === false) return null;
    $ext = strtolower(substr($name, $dot + 1));
    if (!in_array($ext, MEDIA_EXT, true)) return null;
    $stem = strtolower((string)preg_replace('/[^a-zA-Z0-9_-]+/', '-', substr($name, 0, $dot)));
    $stem = trim($stem, '-');
    if ($stem === '') $stem = 'image';
    return substr($stem, 0, 60) . '.' . $ext;
}

function media_list(): array {
    $dir = media_dir();
    $out = [];
    if (is_dir($dir)) {
        $rows = [];
        foreach (scandir($dir) ?: [] as $f) {
            $p = "$dir/$f";
            if (!is_file($p)) continue;
            $dot = strrpos($f, '.');
            if ($dot === false || !in_array(strtolower(substr($f, $dot + 1)), MEDIA_EXT, true)) continue;
            $rows[] = [$f, (int)@filemtime($p), (int)@filesize($p)];
        }
        usort($rows, fn($a, $b) => $b[1] <=> $a[1]);
        foreach ($rows as $r) $out[] = ['name' => $r[0], 'url' => 'config/uploads/' . $r[0], 'size' => $r[2]];
    }
    return $out;
}

/** The image format from the MAGIC BYTES — the client's file name is not evidence. */
function media_magic_ext(string $raw): ?string {
    if (substr($raw, 0, 4) === 'RIFF' && substr($raw, 8, 4) === 'WEBP') return 'webp';
    if (substr($raw, 0, 8) === "\x89PNG\r\n\x1a\n")                     return 'png';
    if (substr($raw, 0, 3) === "\xff\xd8\xff")                          return 'jpg';
    if (substr($raw, 0, 6) === 'GIF87a' || substr($raw, 0, 6) === 'GIF89a') return 'gif';
    if (substr($raw, 4, 4) === 'ftyp' && in_array(substr($raw, 8, 4), ['avif', 'avis'], true)) return 'avif';
    return null;
}

function media_upload(array $body): array {
    $name = media_safe_name(lumen_str($body['filename'] ?? null) ?? lumen_str($body['name'] ?? null) ?? '');
    if ($name === null) return ['ok' => false, 'error' => 'Type de fichier non supporté (png, jpg, webp, gif, avif)'];
    $data = lumen_str($body['data'] ?? null) ?? '';
    if (strncmp($data, 'data:', 5) === 0) { $c = strpos($data, ','); if ($c !== false) $data = substr($data, $c + 1); }
    if (strlen($data) > (int)ceil(MEDIA_MAX / 3) * 4 + 4) return ['ok' => false, 'error' => 'Fichier vide ou trop volumineux (max 8 Mo)'];
    $raw = base64_decode($data, true);
    if ($raw === false || $raw === '' || strlen($raw) > MEDIA_MAX) return ['ok' => false, 'error' => 'Fichier vide ou trop volumineux (max 8 Mo)'];
    // The stored extension is the one the bytes prove, so a page can never be made
    // to serve something else under an image name.
    $magic = media_magic_ext($raw);
    if ($magic === null) return ['ok' => false, 'error' => 'Type de fichier non supporté (png, jpg, webp, gif, avif)'];
    $dir = media_dir();
    if (!admin_make_dir($dir)) return ['ok' => false, 'error' => 'Écriture impossible'];
    lumen_write_guard("$dir/.htaccess", lumen_media_guard());   // served tree: no script ever runs here
    $dot  = strrpos($name, '.');
    $stem = substr($name, 0, $dot);
    $ext  = $magic;
    $name = "$stem.$ext";
    $i = 1;
    while (is_file("$dir/$name")) { $name = "$stem-$i.$ext"; $i++; }
    if (!lumen_write_file_atomic("$dir/$name", $raw)) return ['ok' => false, 'error' => 'Écriture impossible'];
    return ['ok' => true, 'url' => 'config/uploads/' . $name, 'name' => $name];
}

function media_delete(string $name): bool {
    $name = media_safe_name($name);
    if ($name === null) return false;
    $p = media_dir() . '/' . $name;
    if (is_file($p) && !@unlink($p)) return false;
    return true;
}

if (!admin_is_auth()) admin_json_out(['error' => 'Not authenticated'], 401);

if ($action === 'list') admin_json_out(['files' => media_list()]);

if (in_array($action, ['upload', 'delete'], true)) {
    admin_require_write();  // POST + CSRF; exits on failure
    if ($action === 'upload') { $r = media_upload(is_array($body) ? $body : []); admin_json_out($r, $r['ok'] ? 200 : 400); }
    if ($action === 'delete') admin_json_out(media_delete(lumen_str($body['name'] ?? null) ?? '') ? ['ok' => true] : ['error' => 'Invalid file'], 200);
}

admin_json_out(['error' => 'Unknown action'], 400);
