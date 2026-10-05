<?php
/**
 * IRIBHM Microscopy Platform — public catalog endpoint
 * ====================================================
 * Serves the dataset catalog derived from DATA_WEB/<type>/<name>/metadata.json —
 * the same document dev_server.py builds (_build_catalog): every metadata field of
 * each configured or thumbnailed, non-hidden dataset, newest first. See
 * rebuild_catalog() in _admin_lib.php.
 *
 * Why there is no catalog.json behind this
 * ----------------------------------------
 * The catalog holds NO information of its own: every field is copied from a
 * dataset's metadata.json or deduced from the directory (thumbnail if the file
 * exists, identity from the folder). It used to be a static file that only the admin
 * panel rewrote, so a dataset uploaded by SFTP stayed invisible until someone clicked
 * "Régénérer catalog.json". It is built from the tree instead.
 *
 * Cost: the built document is cached in api/.catalog-cache.json, keyed by a
 * signature made of stat calls only (type directories, dataset folders, metadata.json
 * mtime + size), so a page view decodes no metadata.json unless one changed; every
 * write through the admin API also drops the cache. A response carries an ETag, and a
 * revalidation with a matching If-None-Match costs a 304.
 *
 * A public GET never WRITES a dataset: the identity repair of metadata.json runs in
 * the admin paths (datasets.php, upload.php). The one migration step kept here is the
 * rename of the legacy type directories (fixed → 3d, wholemount → 2d), because the
 * scan reads the canonical names and a host that had not migrated yet would answer
 * with an empty catalog; it is guarded by two is_dir() calls.
 *
 * Wired in .htaccess and router.php:
 *   RewriteRule ^DATA_WEB/catalog\.json$ api/catalog.php [L,QSA]
 *
 * Public on purpose: the catalog is public data. No session, no auth, read-only.
 */

declare(strict_types=1);
require_once __DIR__ . '/_admin_lib.php';

if (lumen_migration_dirs_pending()) lumen_migrate_dataset_types();

$body = lumen_catalog_json();
$etag = '"' . substr(hash('sha256', $body), 0, 32) . '"';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
// Revalidated on every use (the catalog changes whenever a dataset does), but a
// matching ETag answers with an empty 304 instead of the whole document.
header('Cache-Control: no-cache');
header('ETag: ' . $etag);

// mod_deflate (DeflateAlterETag, on by default) sends the compressed answer as
// "<etag>-gzip", which the browser then quotes back: strip that suffix and a weak
// prefix, or a gzipped host would never answer 304.
$inm = (string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
$seen = array_map(fn($t) => (string)preg_replace(['/^W\//', '/-gzip"$/'], ['', '"'], trim($t)), explode(',', $inm));
if ($inm !== '' && in_array($etag, $seen, true)) {
    http_response_code(304);
    exit;
}
echo $body;
